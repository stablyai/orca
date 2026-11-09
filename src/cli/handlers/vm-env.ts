import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import {
  formatEnvironmentDoctorChecks,
  type EnvironmentDoctorResult
} from '../../shared/environment-doctor-types'
import { runEnvironmentDoctor } from '../../main/environment-doctor/environment-doctor'
import { createHostEnvironmentDoctorDeps } from '../../main/environment-doctor/environment-doctor-host'

export const VM_ENV_HANDLERS: Record<string, CommandHandler> = {
  'vm env doctor': async ({ flags, cwd, json }) => {
    const pathFlag = flags.get('path')
    const worktreePath = resolve(cwd, typeof pathFlag === 'string' && pathFlag ? pathFlag : '.')
    const result = await runEnvironmentDoctor(
      { worktreePath, runSetup: flags.get('run-setup') === true },
      createHostEnvironmentDoctorDeps()
    )
    console.log(json ? JSON.stringify(result, null, 2) : formatEnvironmentDoctorResult(result))
    if (!result.ok) {
      process.exitCode = 1
    }
  }
}

function formatEnvironmentDoctorResult(result: EnvironmentDoctorResult): string {
  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const check of result.checks) {
    counts[check.status] += 1
  }
  const lines = [`path: ${result.worktreePath}`, ...formatEnvironmentDoctorChecks(result.checks)]
  lines.push(`${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed`)
  return lines.join('\n')
}
