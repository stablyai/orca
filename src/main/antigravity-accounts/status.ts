import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AntigravityAccountStatus } from '../../shared/rate-limit-types'

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function getAntigravityAccountStatus(): Promise<AntigravityAccountStatus> {
  const home = homedir()
  const googleAccountsPaths = [
    path.join(home, '.gemini', 'google_accounts.json'),
    path.join(home, '.antigravity', 'google_accounts.json')
  ]

  let email: string | null = null
  for (const accPath of googleAccountsPaths) {
    if (await fileExists(accPath)) {
      try {
        const content = await readFile(accPath, 'utf-8')
        const data = JSON.parse(content) as { active?: string }
        if (data.active && typeof data.active === 'string') {
          email = data.active
          break
        }
      } catch {
        // ignore parse error, check next
      }
    }
  }

  const credPaths = [
    path.join(home, '.gemini', 'oauth_creds.json'),
    path.join(home, '.antigravity', 'oauth_creds.json')
  ]

  let hasCreds = false
  let tokenFresh = false

  for (const credPath of credPaths) {
    if (await fileExists(credPath)) {
      try {
        const content = await readFile(credPath, 'utf-8')
        const data = JSON.parse(content) as {
          access_token?: string
          refresh_token?: string
          expiry_date?: number
        }
        if (data.access_token || data.refresh_token) {
          hasCreds = true
          if (typeof data.expiry_date === 'number' && data.expiry_date > Date.now()) {
            tokenFresh = true
          }
          break
        }
      } catch {
        // ignore parse error
      }
    }
  }

  // Also check OpenCode auth.json fallback
  if (!hasCreds && !email) {
    const opencodeCandidates = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'auth.json') : null,
      process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
        : null,
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      path.join(home, 'Library', 'Application Support', 'opencode', 'auth.json')
    ].filter((c): c is string => c !== null)

    for (const cand of opencodeCandidates) {
      if (await fileExists(cand)) {
        try {
          const content = await readFile(cand, 'utf-8')
          const parsed = JSON.parse(content) as {
            google?: { type: string; access?: string; expires?: number }
          }
          if (parsed.google?.type === 'oauth') {
            hasCreds = true
            tokenFresh =
              typeof parsed.google.expires === 'number' && parsed.google.expires > Date.now()
            break
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const signedIn = Boolean(email || hasCreds)

  return {
    signedIn,
    email,
    tokenFresh,
    error: null
  }
}
