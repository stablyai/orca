import { setWindowsSecurityForTests } from '../../shared/windows-security-addon'
import {
  createFakeWindowsSecurity,
  daclFromSddl
} from '../../shared/windows-security-addon.test-fixture'
import type {
  InstallDirPackageGrantOutcome,
  InstallDirPackageGrants
} from './windows-install-dir-package-acl-grant'

/** Use readable SDDL fixtures while feeding structured ACEs to real probe logic. */

export const ORPHAN_PACKAGE_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)'
/** ALL RESTRICTED APPLICATION PACKAGES; SDDL has no alias for it. */
export const RESTRICTED_PACKAGES_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-2)'
/** ALL APPLICATION PACKAGES (`AC`), the Program Files default: healthy installs launch clean. */
export const ALL_PACKAGES_ACE = '(A;;0x1200a9;;;AC)'

export const BASELINE_ACES = [
  '(A;OICIID;FA;;;SY)',
  '(A;OICIID;FA;;;BA)',
  '(A;OICIID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)'
]

export function savedDacl(aces: string[]): string {
  return `D:AI${[...aces, ...BASELINE_ACES].join('')}`
}

/** Fake extra ACEs/raw SDDL; null throws for unreadable targets. Returns read paths; reset with resetWindowsSecurityLoadForTests. */
export function installFakeDacls(saved: (target: string) => string[] | string | null): {
  calls: string[]
} {
  const calls: string[] = []
  const fake = createFakeWindowsSecurity()
  fake.getDaclAces = (addonPath: string) => {
    const path = addonPath.startsWith('\\\\?\\') ? addonPath.slice(4) : addonPath
    calls.push(path)
    const aces = saved(path)
    if (aces === null) {
      throw new Error('GetNamedSecurityInfoW failed with Win32 error 5')
    }
    return daclFromSddl(typeof aces === 'string' ? aces : savedDacl(aces))
  }
  setWindowsSecurityForTests(fake)
  return { calls }
}

export type InstallDirPackageGrantPass = keyof InstallDirPackageGrants

export type InstallDirPackageGrant = (
  installDir: string,
  pass: InstallDirPackageGrantPass
) => Promise<InstallDirPackageGrantOutcome>

export function grantsFrom(grant: InstallDirPackageGrant): InstallDirPackageGrants {
  return {
    root: (installDir) => grant(installDir, 'root'),
    tree: (installDir) => grant(installDir, 'tree')
  }
}

/** Record both passes; reply controls outcome and defaults to success. */
export function fakePackageGrant(
  reply: (
    pass: InstallDirPackageGrantPass
  ) => Partial<InstallDirPackageGrantOutcome> | Promise<InstallDirPackageGrantOutcome> = () => ({})
): {
  grants: InstallDirPackageGrants
  passes: { installDir: string; pass: InstallDirPackageGrantPass }[]
} {
  const passes: { installDir: string; pass: InstallDirPackageGrantPass }[] = []
  const grants = grantsFrom(async (installDir, pass) => {
    passes.push({ installDir, pass })
    const outcome = await reply(pass)
    return { ok: true, failedFileCount: 0, ...outcome }
  })
  return { grants, passes }
}
