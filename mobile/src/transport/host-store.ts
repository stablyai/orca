import AsyncStorage from '@react-native-async-storage/async-storage'
import { HostProfileSchema, type HostProfile } from './types'

const STORAGE_KEY = 'orca:hosts'

export async function loadHosts(): Promise<HostProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      const result = HostProfileSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

export async function saveHost(host: HostProfile): Promise<void> {
  const hosts = await loadHosts()
  const index = hosts.findIndex((h) => h.id === host.id)
  if (index >= 0) {
    hosts[index] = host
  } else {
    hosts.push(host)
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
}

export async function removeHost(hostId: string): Promise<void> {
  const hosts = await loadHosts()
  const filtered = hosts.filter((h) => h.id !== hostId)
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export async function renameHost(hostId: string, newName: string): Promise<void> {
  const hosts = await loadHosts()
  const host = hosts.find((h) => h.id === hostId)
  if (host) {
    host.name = newName
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
  }
}

export async function getNextHostName(): Promise<string> {
  const hosts = await loadHosts()
  const existingNumbers = hosts
    .map((h) => {
      const match = h.name.match(/^Host (\d+)$/)
      return match ? parseInt(match[1]!, 10) : 0
    })
    .filter((n) => n > 0)
  const next = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1
  return `Host ${next}`
}

export async function updateLastConnected(hostId: string): Promise<void> {
  const hosts = await loadHosts()
  const host = hosts.find((h) => h.id === hostId)
  if (host) {
    host.lastConnected = Date.now()
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
  }
}
