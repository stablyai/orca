import { expect } from 'vitest'

export function linuxInstallPackageList(step, jobName) {
  const packages = step.env?.ORCA_E2E_APT_PACKAGES
  if (packages !== undefined) {
    expect(step.run, jobName).toContain('read -r -a packages <<< "$ORCA_E2E_APT_PACKAGES"')
    expect(step.run, jobName).toContain('sudo apt-get install -y "${packages[@]}"')
  }
  return packages ?? step.run
}
