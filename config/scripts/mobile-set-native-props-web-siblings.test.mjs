import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every `setNativeProps` write the mobile app makes, and the web sibling it owes.
 *
 * `setNativeProps` is a React Native host-component method. On React Native Web a ref is the DOM
 * node itself and has no such method, so the call is not a write that does nothing — it is a
 * `TypeError`. Where it is made from a render or an effect, that throw reaches the page's fault
 * boundary and takes the whole screen down; the shell then tears the view out from under the
 * route, which is how one imperative write becomes a 0x0 terminal and a keyboard that never
 * opens.
 *
 * Fenced by absence rather than by a list of approved callers: a module that starts writing this
 * way is held to the rule without anyone remembering to add it here. The rule names the file
 * rather than the call, because a `.web.ts(x)` sibling is what the page bundler resolves in its
 * place, and that substitution is per module.
 *
 * Both trees the bundler resolves out of are scanned, and `app` is judged more strictly: a route
 * file may not make the call at all, because expo-router registers a `.web.tsx` beside a route as
 * a second route rather than as a platform sibling, so the split has to live in `src`.
 *
 * Two offences this caught, both invisible natively and both now fixed by one seam:
 * `use-terminal-live-pending-input-flush.ts` cleared the live-input field from the session route's
 * mount effect, and `use-terminal-live-accessory-input-commit.ts` wrote the shortened text into it
 * when the accessory bar erased a character. Both now call
 * `src/terminal/terminal-live-input-text-write.ts`, which ships the sibling.
 */

const mobileDir = join(fileURLToPath(new URL('../../', import.meta.url)), 'mobile')

/**
 * Both trees the page bundler resolves modules out of. `app` is the route tree the shell serves,
 * and it is judged by a stricter rule: expo-router registers a `.web.tsx` beside a route as a
 * second route rather than as a platform sibling, so a route file cannot own a platform split at
 * all and the write has to move into a `src` module that can.
 */
const SCANNED = ['src', 'app']

const SOURCE = /\.tsx?$/
const WEB_SIBLING = /\.web\.tsx?$/
const TEST = /\.(test|spec)\.tsx?$/
/** The call, not the word: a docstring naming it is not a write. */
const NATIVE_WRITE = /\.setNativeProps\(/

async function listFiles(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') {
      continue
    }
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(entryPath)))
    } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      out.push(entryPath)
    }
  }
  return out
}

const posix = (path) => path.split('\\').join('/')

const exists = (path) =>
  readFile(path).then(
    () => true,
    () => false
  )

/** Takes the root so the census can be run against a scratch tree and shown to fail. */
export async function nativePropsWriteSites(rootDir) {
  const found = []
  for (const tree of SCANNED) {
    const directory = join(rootDir, tree)
    if (!existsSync(directory)) {
      continue
    }
    for (const file of await listFiles(directory)) {
      if (NATIVE_WRITE.test(await readFile(file, 'utf8'))) {
        found.push(posix(relative(rootDir, file)))
      }
    }
  }
  return found.sort()
}

/** Every `src` module that writes this way and has no `.web.ts(x)` to be replaced by. */
export async function nativePropsWritesWithoutWebSibling(rootDir) {
  const offenders = []
  for (const site of await nativePropsWriteSites(rootDir)) {
    if (WEB_SIBLING.test(site) || !site.startsWith('src/')) {
      continue
    }
    const base = join(rootDir, site).replace(SOURCE, '')
    const hasSibling = (await exists(`${base}.web.ts`)) || (await exists(`${base}.web.tsx`))
    if (!hasSibling) {
      offenders.push(site)
    }
  }
  return offenders
}

/** Every route file that writes this way, which no sibling can rescue. */
export async function routeTreeNativePropsWrites(rootDir) {
  return (await nativePropsWriteSites(rootDir)).filter((site) => site.startsWith('app/'))
}

describe('the setNativeProps writes the mobile app makes', () => {
  it('gives every one of them a web sibling for the page to resolve instead', async () => {
    expect(await nativePropsWritesWithoutWebSibling(mobileDir)).toEqual([])
  })

  it('makes none of them from a route file, which can carry no platform sibling', async () => {
    expect(await routeTreeNativePropsWrites(mobileDir)).toEqual([])
  })

  it('makes none of them from a web sibling, where the method does not exist at all', async () => {
    // The other half of the same rule. A sibling that kept the native call would satisfy the case
    // above — the file it replaces has one — and still throw on the page.
    expect(
      (await nativePropsWriteSites(mobileDir)).filter((site) => WEB_SIBLING.test(site))
    ).toEqual([])
  })

  it('reads writes at all, so the two rules above are not vacuous', async () => {
    // An empty offender list is also what a tree with no `setNativeProps` in it produces. These
    // are the three seams that own every such write today, each beside its own `.web.ts`, and
    // the list spans both scanned trees so `app` having none is a reading rather than a gap.
    expect(await nativePropsWriteSites(mobileDir)).toEqual([
      'src/browser/browser-frame-layer-paint.ts',
      'src/terminal/terminal-live-input-text-write.ts',
      'src/terminal/terminal-settings-scroll-lock.ts'
    ])
  })
})

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-set-native-props-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function plant(scratch, file, source) {
  await mkdir(join(scratch, file, '..'), { recursive: true })
  await writeFile(join(scratch, file), source, 'utf8')
}

const WRITES = 'export const paint = (ref) => ref.current?.setNativeProps({ text: "" })\n'

// A census that happens to be run against a tree with no offence in it passes for the wrong
// reason. These plant the shapes it claims to judge and show what it would report.
describe('the census scan', () => {
  it('names a native module that writes with no sibling beside it', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'src/terminal/use-terminal-live-pending-input-flush.ts', WRITES)
      await plant(scratch, 'src/terminal/use-terminal-live-accessory-input-commit.ts', WRITES)
      expect(await nativePropsWritesWithoutWebSibling(scratch)).toEqual([
        'src/terminal/use-terminal-live-accessory-input-commit.ts',
        'src/terminal/use-terminal-live-pending-input-flush.ts'
      ])
    })
  })

  it('clears a native module once its sibling is on disk, for .ts and for .tsx', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'src/terminal/write.ts', WRITES)
      await plant(scratch, 'src/terminal/write.web.ts', 'export const paint = () => {}\n')
      await plant(scratch, 'src/browser/Pane.tsx', WRITES)
      await plant(scratch, 'src/browser/Pane.web.tsx', 'export const paint = () => {}\n')
      expect(await nativePropsWritesWithoutWebSibling(scratch)).toEqual([])
    })
  })

  it('names a route file that writes, and is not satisfied by a sibling beside it', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'app/terminal-settings.tsx', WRITES)
      // Planted to show the stricter rule is not the sibling rule wearing a different name: a
      // route with a `.web.tsx` next to it is still an offence, because expo-router reads that
      // file as a second route.
      await plant(scratch, 'app/terminal-settings.web.tsx', 'export default () => null\n')
      expect(await routeTreeNativePropsWrites(scratch)).toEqual(['app/terminal-settings.tsx'])
      expect(await nativePropsWritesWithoutWebSibling(scratch)).toEqual([])
    })
  })

  it('skips tests, which write this way to prove the native call throws', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'src/terminal/write.test.ts', WRITES)
      await plant(scratch, 'src/terminal/write.spec.tsx', WRITES)
      expect(await nativePropsWriteSites(scratch)).toEqual([])
    })
  })
})
