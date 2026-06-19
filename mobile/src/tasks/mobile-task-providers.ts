export type TaskProvider = 'github' | 'gitlab' | 'linear'

const MOBILE_TASK_PROVIDERS: readonly TaskProvider[] = ['github', 'gitlab', 'linear']

const TASK_PROVIDER_SET = new Set<TaskProvider>(MOBILE_TASK_PROVIDERS)

export function normalizeVisibleTaskProviders(value: unknown): TaskProvider[] {
  if (!Array.isArray(value)) {
    return [...MOBILE_TASK_PROVIDERS]
  }

  const normalized: TaskProvider[] = []
  for (const provider of value) {
    if (!TASK_PROVIDER_SET.has(provider as TaskProvider)) {
      continue
    }
    if (!normalized.includes(provider as TaskProvider)) {
      normalized.push(provider as TaskProvider)
    }
  }

  // Why: at least one provider must remain visible so the Tasks surface always
  // has a valid source to select after settings hydration or manual edits.
  return normalized.length > 0 ? normalized : [...MOBILE_TASK_PROVIDERS]
}

export type TaskProviderAvailability = {
  gitlabInstalled: boolean
  linearConnected: boolean
}

export function filterAvailableTaskProviders(
  visibleProviders: readonly TaskProvider[],
  availability: TaskProviderAvailability
): TaskProvider[] {
  const available = visibleProviders.filter((provider) => {
    if (provider === 'github') {
      return true
    }
    if (provider === 'gitlab') {
      return availability.gitlabInstalled
    }
    return availability.linearConnected
  })

  return available.length > 0 ? available : ['github']
}

export function resolveVisibleTaskProvider(
  preferred: TaskProvider | null | undefined,
  visibleProviders: readonly TaskProvider[]
): TaskProvider {
  if (preferred && visibleProviders.includes(preferred)) {
    return preferred
  }
  return visibleProviders[0] ?? 'github'
}
