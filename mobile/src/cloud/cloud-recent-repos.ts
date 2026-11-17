import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'

// Repositories this phone started cloud workspaces from, newest first, for the new-workspace picker.

const KEY = 'orca:cloud-recent-repos:v1'
const MAX = 8

/** "owner/repo" for a GitHub URL (or an "owner/repo" already), else null. */
export function cloudRepoSlug(url: string): string | null {
  const match =
    /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return match ? `${match[1]}/${match[2]}` : null
}

export async function loadRecentCloudRepos(): Promise<string[]> {
  try {
    const parsed = z
      .array(z.string())
      .safeParse(JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]'))
    return parsed.success ? parsed.data.slice(0, MAX) : []
  } catch {
    return []
  }
}

export async function recordRecentCloudRepo(url: string): Promise<void> {
  const slug = cloudRepoSlug(url)
  if (!slug) {
    return
  }
  const next = [slug, ...(await loadRecentCloudRepos()).filter((entry) => entry !== slug)].slice(
    0,
    MAX
  )
  await AsyncStorage.setItem(KEY, JSON.stringify(next))
}

/** Recents first, then the team's projects (repos of its cloud workspaces), each once. */
export function cloudRepoChoices(
  recents: readonly string[],
  teamRepoUrls: readonly string[]
): string[] {
  const seen = new Set<string>()
  const choices: string[] = []
  for (const slug of [...recents, ...teamRepoUrls.flatMap((url) => cloudRepoSlug(url) ?? [])]) {
    const key = slug.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      choices.push(slug)
    }
  }
  return choices.slice(0, 12)
}
