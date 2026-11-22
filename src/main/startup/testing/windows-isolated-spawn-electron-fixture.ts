// Electron main entry for windows-isolated-spawner.win32.test.ts: Electron keeps its std handles
// inheritable, so a holder spawned through libuv pins the test's pipe and an isolated one must not.
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type * as WindowsSecurity from '@orca/windows-security'
import {
  setIsolatedSpawner,
  spawnDetachedWithoutInheritance
} from '@orca/process-host/isolated-detached-spawn'

const [addonPath, mode, holderMs, resultFile] = process.argv.slice(-4)
const addon: typeof WindowsSecurity = createRequire(__filename)(addonPath)
if (mode === 'isolated') {
  setIsolatedSpawner(addon.spawnDetachedIsolated)
}
const holder = spawnDetachedWithoutInheritance({
  program: process.execPath,
  args: ['-e', `setTimeout(() => {}, ${holderMs})`],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
holder.once('error', (error) => {
  writeFileSync(resultFile, `error ${String(error)}`)
  app.exit(1)
})
holder.once('spawn', () => {
  writeFileSync(resultFile, String(holder.pid))
  app.exit(0)
})
