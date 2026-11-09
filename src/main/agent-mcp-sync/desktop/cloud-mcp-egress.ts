// Opens the sandbox's network allowlist for the remote MCP servers a sync sends. The control plane
// keeps the list on the workspace, so it applies to the running sandbox now and on every later boot.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { mergeMcpEgressHosts } from '../../../shared/agent-mcp-sync/mcp-egress-hosts'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import {
  createHostedSandboxRequest,
  type HostedSandboxControlPlaneClientOptions,
  type HostedSandboxRequest
} from '../../hosted-sandbox/hosted-sandbox-request'

const EgressHostsResponse = z.object({ hosts: z.array(z.string()) })

export type McpEgressResult = { hosts: string[]; dropped: string[] }

export type CloudMcpEgress = {
  /** Makes `wanted` reachable from the sandbox; returns what the sandbox now allows. */
  apply(sandboxId: string, wanted: readonly string[]): Promise<McpEgressResult>
}

type OwnedLedger = Record<string, string[]>

export function createCloudMcpEgress(deps: {
  userDataPath: string
  controlPlane: HostedSandboxControlPlaneClientOptions
  request?: HostedSandboxRequest
}): CloudMcpEgress {
  const call = deps.request ?? createHostedSandboxRequest(deps.controlPlane)
  // Which hosts MCP sync added, per sandbox, so a removed server's host can be taken back
  // without touching hosts any other tool declared.
  const ledgerPath = join(deps.userDataPath, 'cloud-mcp-egress.json')
  const readLedger = async (): Promise<OwnedLedger> => {
    try {
      const parsed = z
        .record(z.string(), z.array(z.string()))
        .safeParse(JSON.parse(await readFile(ledgerPath, 'utf8')))
      return parsed.success ? parsed.data : {}
    } catch {
      return {}
    }
  }

  return {
    async apply(sandboxId, wanted) {
      const path = `v1/sandboxes/${encodeURIComponent(sandboxId)}/egress/hosts`
      const ledger = await readLedger()
      const owned = ledger[sandboxId] ?? []
      if (wanted.length === 0 && owned.length === 0) {
        return { hosts: [], dropped: [] }
      }
      const current = (await call('GET', path, EgressHostsResponse, { kind: 'control' })).hosts
      const merge = mergeMcpEgressHosts({ current, owned, wanted })
      const sorted = [...current].sort()
      const unchanged =
        merge.hosts.length === sorted.length && merge.hosts.every((host, i) => host === sorted[i])
      const hosts = unchanged
        ? current
        : (
            await call('PUT', path, EgressHostsResponse, {
              body: { hosts: merge.hosts },
              kind: 'control'
            })
          ).hosts
      const next = { ...ledger }
      if (merge.owned.length > 0) {
        next[sandboxId] = merge.owned
      } else {
        delete next[sandboxId]
      }
      writeFileAtomically(ledgerPath, `${JSON.stringify(next, null, 2)}\n`)
      return { hosts, dropped: merge.dropped }
    }
  }
}
