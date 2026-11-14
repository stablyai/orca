import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/agent-session-create-capabilities'
import { AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY } from '../../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import { hostPickerOptions } from '../../components/use-connected-host-picker'
import { selectConnectableHostProfiles } from '../../host-catalog/host-catalog-selection'
import type { HostProfile } from '../../host-catalog/host-profile'
import { loadHostCatalog } from '../../host-catalog/host-store'
import { startRuntimeCapabilityProbe } from '../../transport/connection/runtime-capability-probe'
import { useAllHostClients } from '../../transport/connection/use-all-host-clients'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ChatForkHost, ChatForkHostStatus } from './chat-fork-selection'

export type ChatForkHostRow = ChatForkHost & {
  label: string
  subtitle?: string
  client: RpcClient | null
  current: boolean
}

const NO_HOSTS: readonly HostProfile[] = []

/** Every paired desktop as a fork target: this one first, the rest probed for chat import while the sheet is open. */
export function useChatForkHosts(input: {
  currentHostId: string
  currentClient: RpcClient | null
  currentCapabilities: readonly string[] | undefined
}): readonly ChatForkHostRow[] {
  const profiles = useHostProfiles()
  const otherIds = useMemo(
    () => profiles.filter((host) => host.id !== input.currentHostId).map((host) => host.id),
    [profiles, input.currentHostId]
  )
  const clients = useAllHostClients(otherIds)
  const capabilities = useHostCapabilities(clients)
  return useMemo(() => {
    const options = new Map(hostPickerOptions([...profiles]).map((row) => [row.value, row]))
    const current: ChatForkHostRow = {
      hostId: input.currentHostId,
      status: 'ready',
      label: options.get(input.currentHostId)?.label ?? input.currentHostId,
      subtitle: options.get(input.currentHostId)?.subtitle,
      client: input.currentClient,
      current: true,
      ...capabilityFlags(input.currentCapabilities)
    }
    const others = otherIds.map((hostId): ChatForkHostRow => {
      const entry = clients.find((candidate) => candidate.hostId === hostId)
      const connected = entry?.state === 'connected'
      const caps = connected ? capabilities.get(entry.client) : undefined
      const status: ChatForkHostStatus = !connected
        ? 'offline'
        : !caps
          ? 'checking'
          : caps.includes(AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY)
            ? 'ready'
            : 'needs-update'
      return {
        hostId,
        status,
        label: options.get(hostId)?.label ?? hostId,
        subtitle: options.get(hostId)?.subtitle,
        client: connected ? entry.client : null,
        current: false,
        ...capabilityFlags(caps)
      }
    })
    return [current, ...others]
  }, [
    profiles,
    otherIds,
    clients,
    capabilities,
    input.currentHostId,
    input.currentClient,
    input.currentCapabilities
  ])
}

function capabilityFlags(
  capabilities: readonly string[] | undefined
): Pick<ChatForkHost, 'canImport' | 'canFirstMessage'> {
  return {
    canImport: capabilities?.includes(AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY) === true,
    canFirstMessage:
      capabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY) === true
  }
}

function useHostProfiles(): readonly HostProfile[] {
  const [profiles, setProfiles] = useState<readonly HostProfile[]>(NO_HOSTS)
  useEffect(() => {
    let live = true
    loadHostCatalog()
      .then(selectConnectableHostProfiles, () => [])
      .then((loaded) => {
        if (live) {
          setProfiles(loaded)
        }
      })
    return () => {
      live = false
    }
  }, [])
  return profiles
}

/** Each connected client's advertised capabilities, asked again whenever it reconnects. */
function useHostCapabilities(
  clients: readonly { client: RpcClient; state: string }[]
): ReadonlyMap<RpcClient, readonly string[]> {
  const [answers, setAnswers] = useState<ReadonlyMap<RpcClient, readonly string[]>>(new Map())
  const probes = useRef(new Map<RpcClient, () => void>())
  useEffect(() => {
    const wanted = new Set(
      clients.filter((entry) => entry.state === 'connected').map((entry) => entry.client)
    )
    for (const [client, stop] of probes.current) {
      if (!wanted.has(client)) {
        stop()
        probes.current.delete(client)
      }
    }
    for (const client of wanted) {
      if (!probes.current.has(client)) {
        const stop = startRuntimeCapabilityProbe(client, (capabilities) =>
          setAnswers((previous) => new Map(previous).set(client, capabilities))
        )
        probes.current.set(client, stop)
      }
    }
  }, [clients])
  useEffect(() => {
    const running = probes.current
    return () => {
      for (const stop of running.values()) {
        stop()
      }
      running.clear()
    }
  }, [])
  return answers
}
