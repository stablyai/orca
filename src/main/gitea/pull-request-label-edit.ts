import { requestGiteaJson } from './gitea-json-request'
import {
  encodedGiteaRepoPath,
  giteaWriteUsesTea,
  writeGiteaJson,
  type GiteaMutationFailure,
  type GiteaMutationResult
} from './pull-request-mutation-transport'
import type { GiteaRepoRef } from './repository-ref'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function resolveLabelIds(
  repo: GiteaRepoRef,
  names: string[]
): Promise<{ ok: true; ids: Map<string, number> } | GiteaMutationFailure> {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]))
  const ids = new Map<string, number>()
  for (let page = 1; page <= 50 && ids.size < wanted.size; page += 1) {
    const labels = await requestGiteaJson<unknown>(
      repo,
      `/repos/${encodedGiteaRepoPath(repo)}/labels`,
      { searchParams: { page, limit: 50 } },
      true
    )
    if (!Array.isArray(labels)) {
      return { ok: false, error: 'Could not read repository labels.' }
    }
    for (const label of labels) {
      if (!isRecord(label) || typeof label.name !== 'string' || typeof label.id !== 'number') {
        continue
      }
      const key = label.name.toLowerCase()
      if (wanted.has(key)) {
        ids.set(key, label.id)
      }
    }
    if (labels.length < 50) {
      break
    }
  }
  for (const [key, name] of wanted) {
    if (!ids.has(key)) {
      return { ok: false, error: `Label not found: ${name}` }
    }
  }
  return { ok: true, ids }
}

export async function applyGiteaPullRequestLabelChanges(
  repo: GiteaRepoRef,
  indexArg: string,
  addLabels: string[],
  removeLabels: string[]
): Promise<GiteaMutationResult> {
  if (giteaWriteUsesTea(repo) || (addLabels.length === 0 && removeLabels.length === 0)) {
    return { ok: true }
  }
  const ids = await resolveLabelIds(repo, [...addLabels, ...removeLabels])
  if (!ids.ok) {
    return ids
  }
  const addIds = addLabels.flatMap((name) => {
    const id = ids.ids.get(name.toLowerCase())
    return id === undefined ? [] : [id]
  })
  const removeIds = removeLabels.flatMap((name) => {
    const id = ids.ids.get(name.toLowerCase())
    return id === undefined ? [] : [id]
  })
  for (const id of removeIds) {
    const removed = await writeGiteaJson(
      repo,
      `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}/labels/${id}`,
      'DELETE',
      {}
    )
    if (!removed.ok) {
      return removed
    }
  }
  if (addIds.length === 0) {
    return { ok: true }
  }
  return writeGiteaJson(
    repo,
    `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}/labels`,
    'POST',
    {
      labels: addIds
    }
  )
}
