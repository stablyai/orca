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
 * Two offences this caught, both invisible natively and both now fixed by one seam:
 * `use-terminal-live-pending-input-flush.ts` cleared the live-input field from the session route's
 * mount effect, and `use-terminal-live-accessory-input-commit.ts` wrote the shortened text into it
 * when the accessory bar erased a character. Both now call
 * `src/terminal/terminal-live-input-text-write.ts`, which ships the sibling.
 */

const mobileSrcDir = join(fileURLToPath(new URL('../../', import.meta.url)), 'mobile', 'src')

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
export async function nativePropsWriteSites(srcDir) {
  const found = []
  for (const file of await listFiles(srcDir)) {
    if (NATIVE_WRITE.test(await readFile(file, 'utf8'))) {
      found.push(posix(relative(srcDir, file)))
    }
  }
  return found.sort()
}

/** Every native module that writes this way and has no `.web.ts(x)` to be replaced by. */
export async function nativePropsWritesWithoutWebSibling(srcDir) {
  const offenders = []
  for (const site of await nativePropsWriteSites(srcDir)) {
    if (WEB_SIBLING.test(site)) {
      continue
    }
    const base = join(srcDir, site).replace(SOURCE, '')
    const hasSibling = (await exists(`${base}.web.ts`)) || (await exists(`${base}.web.tsx`))
    if (!hasSibling) {
      offenders.push(site)
    }
  }
  return offenders
}

describe('the setNativeProps writes the mobile app makes', () => {
  it('gives every one of them a web sibling for the page to resolve instead', async () => {
    expect(await nativePropsWritesWithoutWebSibling(mobileSrcDir)).toEqual([])
  })

  it('makes none of them from a web sibling, where the method does not exist at all', async () => {
    // The other half of the same rule. A sibling that kept the native call would satisfy the case
    // above — the file it replaces has one — and still throw on the page.
    expect(
      (await nativePropsWriteSites(mobileSrcDir)).filter((site) => WEB_SIBLING.test(site))
    ).toEqual([])
  })

  it('reads writes at all, so the two rules above are not vacuous', async () => {
    // An empty offender list is also what a tree with no `setNativeProps` in it produces. These
    // are the two seams that own every such write today, each beside its own `.web.ts`.
    expect(await nativePropsWriteSites(mobileSrcDir)).toEqual([
      'browser/browser-frame-layer-paint.ts',
      'terminal/terminal-live-input-text-write.ts'
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
      await plant(scratch, 'terminal/use-terminal-live-pending-input-flush.ts', WRITES)
      await plant(scratch, 'terminal/use-terminal-live-accessory-input-commit.ts', WRITES)
      expect(await nativePropsWritesWithoutWebSibling(scratch)).toEqual([
        'terminal/use-terminal-live-accessory-input-commit.ts',
        'terminal/use-terminal-live-pending-input-flush.ts'
      ])
    })
  })

  it('clears a native module once its sibling is on disk, for .ts and for .tsx', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'terminal/write.ts', WRITES)
      await plant(scratch, 'terminal/write.web.ts', 'export const paint = () => {}\n')
      await plant(scratch, 'browser/Pane.tsx', WRITES)
      await plant(scratch, 'browser/Pane.web.tsx', 'export const paint = () => {}\n')
      expect(await nativePropsWritesWithoutWebSibling(scratch)).toEqual([])
    })
  })

  it('skips tests, which write this way to prove the native call throws', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'terminal/write.test.ts', WRITES)
      await plant(scratch, 'terminal/write.spec.tsx', WRITES)
      expect(await nativePropsWriteSites(scratch)).toEqual([])
    })
  })
})
