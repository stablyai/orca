import type { SshTarget } from '../../shared/ssh-types'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

export type VsCodeSshAuthorityResult =
  | { ok: true; authority: string }
  | { ok: false; reason: 'ssh-target-invalid' }
  | { ok: false; reason: 'ssh-alias-required'; host: string; port: number }

function isValidAuthorityPart(value: string): boolean {
  return (
    value.length > 0 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

export function resolveVsCodeSshAuthority(target: SshTarget): VsCodeSshAuthorityResult {
  if (isOpenSshConfigBackedTarget(target)) {
    const configHost = target.configHost?.trim() ?? ''
    return isValidAuthorityPart(configHost)
      ? { ok: true, authority: configHost }
      : { ok: false, reason: 'ssh-target-invalid' }
  }

  const host = target.host.trim()
  const username = target.username.trim()
  if (
    !isValidAuthorityPart(host) ||
    !isValidAuthorityPart(username) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535
  ) {
    return { ok: false, reason: 'ssh-target-invalid' }
  }
  if (target.port !== 22) {
    return { ok: false, reason: 'ssh-alias-required', host, port: target.port }
  }
  return { ok: true, authority: `${username}@${host}` }
}
