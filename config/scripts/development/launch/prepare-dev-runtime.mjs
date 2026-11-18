import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function prepareDevRuntime() {
  const root = path.resolve(import.meta.dirname, '../../../..')
  for (const [script, ...extra] of [
    ['config/scripts/workspace-package-build/build-workspace-packages.mjs'],
    ['config/scripts/native-build/node-addons/ensure-native-runtime.mjs', '--runtime=electron']
  ]) {
    execFileSync(process.execPath, [path.join(root, script), ...extra], {
      cwd: root,
      stdio: 'inherit',
      env: process.env
    })
  }
}
