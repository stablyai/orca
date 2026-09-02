import { dirname } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { logStartupMilestone } from './startup-diagnostics'
import {
  buildInstallDirAclRepairCommands,
  isInstallDirAclPoisonVerdict,
  repairWindowsInstallDirPackageAcl,
  type WindowsInstallDirAclRepairArgs,
  type WindowsInstallDirAclRepairResult
} from './windows-install-dir-package-acl-repair'

/**
 * Joins the read-only install-DACL probe to the repair, and keeps the verdict so
 * the renderer-recovery dialog can say what is actually wrong instead of blaming
 * the graphics driver. See `windows-install-dir-package-acl-repair.ts`.
 */

export type InstallDirAclPoisonDiagnosis = {
  /** Dialog copy; ends with the commands when the user has to run them. */
  detail: string
  commands: string[]
}

export type WindowsInstallDirAclRecoveryOptions = Omit<WindowsInstallDirAclRepairArgs, 'onDone'>

type RepairStage = WindowsInstallDirAclRepairResult['mode'] | 'pending'

let poison: { installDir: string; stage: RepairStage } | null = null

export function resetWindowsInstallDirAclRecoveryForTest(): void {
  poison = null
}

/** The probe's `onDone`: no-op unless the machine is in the reproduced state. */
export function startWindowsInstallDirAclRepairIfPoisoned(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  if (!isInstallDirAclPoisonVerdict(data)) {
    return
  }
  const installDir = options.installDir ?? dirname(process.execPath)
  poison = { installDir, stage: 'pending' }
  repairWindowsInstallDirPackageAcl({
    ...options,
    installDir,
    onDone: (result) => {
      poison = { installDir, stage: result.mode }
      logStartupMilestone('install-dir-acl-repair-done', { mode: result.mode })
      if (result.mode === 'failed') {
        console.warn('[win32-acl] install dir package ACL repair failed:', result.reason)
      }
    }
  })
}

const CAUSE =
  "Windows permissions on Orca's install folder are blocking its own sandboxed processes from reading the files it shipped with."

// Why the exact commands: the window is blank, so the dialog is the only place a user can be told what to run.
export function describeInstallDirAclPoison(): InstallDirAclPoisonDiagnosis | null {
  if (!poison) {
    return null
  }
  const commands = buildInstallDirAclRepairCommands(poison.installDir)
  if (poison.stage === 'repaired') {
    return { detail: `${CAUSE}\n\nOrca repaired the permissions. Reload to use them.`, commands }
  }
  const status =
    poison.stage === 'pending'
      ? 'Orca is repairing the permissions now.'
      : 'Orca could not repair them, which usually means the folder needs an administrator.'
  return {
    detail: `${CAUSE} ${status}\n\nRun these in an Administrator Command Prompt, then relaunch Orca:\n\n${commands.join('\n')}`,
    commands
  }
}
