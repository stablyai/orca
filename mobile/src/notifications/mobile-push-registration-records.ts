import {
  loadRemotePushHostRegistrations,
  saveRemotePushHostRegistrations
} from '../storage/preferences'

type RegistrationRecords = { registered: Set<string>; pending: Set<string> }
let registrationRecords: RegistrationRecords | null = null

export async function readRecords(): Promise<RegistrationRecords> {
  if (!registrationRecords) {
    const stored = await loadRemotePushHostRegistrations()
    registrationRecords ??= {
      registered: new Set(stored.registeredHostIds),
      pending: new Set(stored.pendingUnregisterHostIds)
    }
  }
  return registrationRecords
}

export async function mutateRecords(mutate: (value: RegistrationRecords) => void): Promise<void> {
  const value = await readRecords()
  mutate(value)
  try {
    await saveRemotePushHostRegistrations({
      registeredHostIds: [...value.registered],
      pendingUnregisterHostIds: [...value.pending]
    })
  } catch (error) {
    registrationRecords = null
    throw error
  }
}

export function resetRegistrationRecords(): void {
  registrationRecords = null
}
