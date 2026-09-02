import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY
} from '../../shared/skill-install-capability'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environment-transport-routing'

export async function supportsSkillRuntimeManagement(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, 15_000)
  return (
    status.ok === true && status.result.capabilities?.includes(SKILL_MANAGEMENT_CAPABILITY) === true
  )
}

export async function supportsSkillRuntimeBundleInstall(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, 15_000)
  return (
    status.ok === true &&
    status.result.capabilities?.includes(SKILL_BUNDLE_INSTALL_CAPABILITY) === true
  )
}

export async function supportsSkillRuntimeCancellation(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, 15_000)
  return (
    status.ok === true &&
    status.result.capabilities?.includes(SKILL_INSTALL_CANCEL_CAPABILITY) === true
  )
}

export async function supportsSkillRuntimeInstall(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, 15_000)
  return (
    status.ok === true && status.result.capabilities?.includes(SKILL_INSTALL_CAPABILITY) === true
  )
}
