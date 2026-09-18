import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePath = fileURLToPath(
  new URL(
    '../../../src/main/native-chat/agent-session-wire/structured-agent-session-holds.ts',
    import.meta.url
  )
)
const source = await readFile(sourcePath, 'utf8')
const postResumeCheck =
  '      // The last surface can disconnect before acquisition makes a child available to release.\n' +
  '      if (!this.disposed && !this.holders.isHeld(sessionId)) {\n' +
  '        this.clock.arm(sessionId)\n' +
  '      }\n'
if (!source.includes(postResumeCheck)) {
  throw new Error('Source changed: review the before-fix transform before running this proof.')
}

async function loadHolds(withPostResumeCheck) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'compare-post-resume-holder-check',
        setup(plugin) {
          plugin.onLoad({ filter: /structured-agent-session-holds\.ts$/ }, () => ({
            contents: withPostResumeCheck ? source : source.replace(postResumeCheck, ''),
            loader: 'ts'
          }))
        }
      }
    ]
  })
  const scratch = await mkdtemp(join(tmpdir(), 'orca-structured-hold-proof-'))
  const require = createRequire(import.meta.url)
  let moduleId
  try {
    const bundlePath = join(scratch, 'holds.cjs')
    await writeFile(bundlePath, result.outputFiles[0].text)
    moduleId = require.resolve(bundlePath)
    return require(moduleId).StructuredAgentSessionHolds
  } finally {
    if (moduleId) {
      delete require.cache[moduleId]
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

async function reproduce(Holds) {
  const gate = Promise.withResolvers()
  let child = false
  let evictions = 0
  const holds = new Holds({
    resume: async () => {
      await gate.promise
      child = true
    },
    hasProviderChild: () => child,
    isTurnActive: () => false,
    evict: async () => {
      evictions += 1
      child = false
    },
    graceMs: 5
  })
  try {
    const acquiring = holds.hold('restored-session', 'connection:surface')
    holds.release('restored-session', 'connection:surface')
    gate.resolve()
    await acquiring
    const releasePendingAfterAcquisition = holds.isReleasePending('restored-session')
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      child,
      held: holds.isHeld('restored-session'),
      releasePendingAfterAcquisition,
      evictions
    }
  } finally {
    holds.dispose()
  }
}

const before = await reproduce(await loadHolds(false))
const after = await reproduce(await loadHolds(true))
const passed =
  before.child &&
  !before.held &&
  !before.releasePendingAfterAcquisition &&
  before.evictions === 0 &&
  !after.child &&
  !after.held &&
  after.releasePendingAfterAcquisition &&
  after.evictions === 1
console.log(
  JSON.stringify(
    {
      source: 'src/main/native-chat/agent-session-wire/structured-agent-session-holds.ts',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      comparison: 'same source, before omits only the post-resume holder check',
      before,
      after,
      passed
    },
    null,
    2
  )
)
if (!passed) {
  process.exitCode = 1
}
