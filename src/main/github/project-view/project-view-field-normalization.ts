import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectIteration,
  GitHubProjectLabel,
  GitHubProjectSingleSelectOption,
  GitHubProjectUser
} from '../../../shared/github/project-types'

// ─── Normalizers ───────────────────────────────────────────────────────

export type RawProjectV2Field = {
  __typename?: string
  id?: string
  name?: string
  dataType?: string
  options?: { id?: string; name?: string; color?: string }[]
  configuration?: {
    iterations?: { id?: string; title?: string; startDate?: string; duration?: number }[]
    completedIterations?: {
      id?: string
      title?: string
      startDate?: string
      duration?: number
    }[]
  }
}

export function normalizeField(
  raw: RawProjectV2Field | null | undefined
): GitHubProjectField | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null
  }
  const dataType = raw.dataType ?? raw.__typename ?? ''
  if (raw.__typename === 'ProjectV2SingleSelectField' || dataType === 'SINGLE_SELECT') {
    const options: GitHubProjectSingleSelectOption[] = (raw.options ?? [])
      .map((o) =>
        typeof o.id === 'string' && typeof o.name === 'string'
          ? { id: o.id, name: o.name, color: o.color ?? '' }
          : null
      )
      .filter((o): o is GitHubProjectSingleSelectOption => o !== null)
    return { kind: 'single-select', id: raw.id, name: raw.name, dataType: 'SINGLE_SELECT', options }
  }
  if (raw.__typename === 'ProjectV2IterationField' || dataType === 'ITERATION') {
    const cfg = raw.configuration ?? {}
    const iterations: GitHubProjectIteration[] = []
    for (const it of cfg.completedIterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: true
        })
      }
    }
    for (const it of cfg.iterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: false
        })
      }
    }
    return { kind: 'iteration', id: raw.id, name: raw.name, dataType: 'ITERATION', iterations }
  }
  return { kind: 'field', id: raw.id, name: raw.name, dataType }
}

export type RawUser = {
  login?: string
  name?: string | null
  avatarUrl?: string | null
}

export function normalizeUser(raw: RawUser | null | undefined): GitHubProjectUser | null {
  if (!raw || typeof raw.login !== 'string') {
    return null
  }
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null
  }
}

export type RawLabel = { name?: string; color?: string }

export function normalizeLabel(raw: RawLabel | null | undefined): GitHubProjectLabel | null {
  if (!raw || typeof raw.name !== 'string') {
    return null
  }
  return { name: raw.name, color: raw.color ?? '' }
}

export type RawFieldValue = {
  __typename?: string
  field?: RawProjectV2Field
  name?: string
  color?: string
  optionId?: string
  title?: string
  startDate?: string
  duration?: number
  iterationId?: string
  text?: string
  number?: number
  date?: string
  labels?: { nodes?: RawLabel[] }
  users?: { nodes?: RawUser[] }
}

export function normalizeFieldValue(
  raw: RawFieldValue | null | undefined
): GitHubProjectFieldValue | null {
  if (!raw || !raw.field || typeof raw.field.id !== 'string') {
    return null
  }
  const fieldId = raw.field.id
  switch (raw.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      if (typeof raw.optionId !== 'string') {
        return null
      }
      return {
        kind: 'single-select',
        fieldId,
        optionId: raw.optionId,
        name: raw.name ?? '',
        color: raw.color ?? ''
      }
    case 'ProjectV2ItemFieldIterationValue':
      if (typeof raw.iterationId !== 'string') {
        return null
      }
      return {
        kind: 'iteration',
        fieldId,
        iterationId: raw.iterationId,
        title: raw.title ?? '',
        startDate: raw.startDate ?? '',
        duration: typeof raw.duration === 'number' ? raw.duration : 0
      }
    case 'ProjectV2ItemFieldTextValue':
      return { kind: 'text', fieldId, text: raw.text ?? '' }
    case 'ProjectV2ItemFieldNumberValue':
      if (typeof raw.number !== 'number') {
        return null
      }
      return { kind: 'number', fieldId, number: raw.number }
    case 'ProjectV2ItemFieldDateValue':
      return { kind: 'date', fieldId, date: raw.date ?? '' }
    case 'ProjectV2ItemFieldLabelValue': {
      const labels = (raw.labels?.nodes ?? [])
        .map(normalizeLabel)
        .filter((l): l is GitHubProjectLabel => l !== null)
      return { kind: 'labels', fieldId, labels }
    }
    case 'ProjectV2ItemFieldUserValue': {
      const users = (raw.users?.nodes ?? [])
        .map(normalizeUser)
        .filter((u): u is GitHubProjectUser => u !== null)
      return { kind: 'users', fieldId, users }
    }
    case undefined:
    default:
      // Unknown __typename → forward-compat: drop silently, don't classify as drift (see design §Error Handling).
      return null
  }
}
