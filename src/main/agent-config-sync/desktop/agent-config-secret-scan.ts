/**
 * Skills sometimes sit next to keys a script reads. Those files stay on this computer: names that
 * hold credentials by convention, and text with a well-known key or token shape.
 */

const SECRET_FILE_NAMES = [
  /^\.?env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx|der|crt)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials?|secrets?|tokens?|auth|service[-_]?account)([-_.].*)?\.(json|ya?ml|toml|txt|ini|env)$/i,
  /^\.?(npmrc|netrc|pypirc|htpasswd|git-credentials)$/i,
  /^client_secret.*\.json$/i
]

const SECRET_CONTENT = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{32,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:rk|sk)_live_[A-Za-z0-9]{20,}\b/,
  /\bvck_[A-Za-z0-9]{20,}\b/
]

export function isSecretFileName(name: string): boolean {
  return SECRET_FILE_NAMES.some((pattern) => pattern.test(name))
}

/** Binary files are not scanned: the patterns are text shapes. */
export function hasSecretContent(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8000).includes(0)) {
    return false
  }
  const text = bytes.toString('utf8')
  return SECRET_CONTENT.some((pattern) => pattern.test(text))
}
