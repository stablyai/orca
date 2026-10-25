import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  ORCAD_ARTIFACTS,
  ORCAD_LINEAR_SDK_ENTRY,
  ORCAD_SERVER_ENTRY_FILENAME
} from '../../src/shared/orcad-artifacts.ts'
import { stageOrcadLinearSdk } from './orcad-linear-sdk-package.mjs'

const root = join(import.meta.dirname, '..', '..')
// Outside the repo, so Node cannot fall back to the checkout's node_modules.
const deployment = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-linear-sdk-')))

beforeAll(async () => {
  await stageOrcadLinearSdk(root, deployment)
}, 60_000)

afterAll(() => {
  rmSync(deployment, { recursive: true, force: true })
})

it("resolves linear-sdk.ts's lazy require from the deployed server under plain Node", () => {
  expect(ORCAD_ARTIFACTS.map((artifact) => artifact.filename)).toContain(ORCAD_LINEAR_SDK_ENTRY)
  const server = join(deployment, ORCAD_SERVER_ENTRY_FILENAME)
  writeFileSync(
    server,
    `const load = require('node:module').createRequire(__filename);
    const sdk = load('@linear/sdk');
    console.log(JSON.stringify({
      resolved: load.resolve('@linear/sdk'),
      client: typeof sdk.LinearClient,
      authError: typeof sdk.AuthenticationLinearError
    }));`
  )
  const loaded = runProcessSync({
    program: process.execPath,
    args: [server],
    cwd: deployment,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr.slice(-2_000)).toBe(0)
  expect(JSON.parse(loaded.stdout.trim())).toEqual({
    resolved: join(deployment, ORCAD_LINEAR_SDK_ENTRY),
    client: 'function',
    authError: 'function'
  })
}, 40_000)
