import { existsSync, readFileSync } from 'node:fs'

/** List available shell profiles from /etc/shells or known fallbacks. */
export function listShellProfiles(): { name: string; path: string }[] {
  const profiles: { name: string; path: string }[] = []
  const seen = new Set<string>()

  try {
    const content = readFileSync('/etc/shells', 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !existsSync(trimmed) || seen.has(trimmed)) {
        continue
      }
      seen.add(trimmed)
      profiles.push({ name: trimmed.split('/').pop() || trimmed, path: trimmed })
    }
  } catch {
    // /etc/shells may not exist on all systems; fall back to known shells.
    for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
      if (existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate)
        profiles.push({ name: candidate.split('/').pop()!, path: candidate })
      }
    }
  }

  return profiles
}
