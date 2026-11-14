import type { SshTarget } from '../../../shared/ssh-types'

type ImportedSshConfigFields = Pick<
  SshTarget,
  | 'configHost'
  | 'host'
  | 'port'
  | 'username'
  | 'identityFile'
  | 'identityFiles'
  | 'identityAgent'
  | 'identitiesOnly'
  | 'gssapiAuthentication'
  | 'proxyCommand'
  | 'jumpHost'
>

export function importedSshConfigFields(candidate: SshTarget): ImportedSshConfigFields {
  return {
    configHost: candidate.configHost,
    host: candidate.host,
    port: candidate.port,
    username: candidate.username,
    identityFile: candidate.identityFile,
    identityFiles: candidate.identityFiles,
    identityAgent: candidate.identityAgent,
    identitiesOnly: candidate.identitiesOnly,
    gssapiAuthentication: candidate.gssapiAuthentication,
    proxyCommand: candidate.proxyCommand,
    jumpHost: candidate.jumpHost
  }
}

function sameIdentityFiles(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right || left.length !== right.length) {
    return false
  }
  return left.every((file, index) => file === right[index])
}

export function importedSshConfigFieldsChanged(
  existing: SshTarget,
  nextFields: ImportedSshConfigFields
): boolean {
  return (Object.keys(nextFields) as (keyof ImportedSshConfigFields)[]).some((key) =>
    key === 'identityFiles'
      ? !sameIdentityFiles(existing.identityFiles, nextFields.identityFiles)
      : existing[key] !== nextFields[key]
  )
}
