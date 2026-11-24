import { requirePluginService } from '../rpc/methods/plugins/plugins'
import { pipelineDigest } from './pipeline-store'
import type {
  PipelineProfile,
  PipelineSelection
} from '../../../shared/pipelines/pipeline-contracts'

export type AvailablePipeline = PipelineSelection & {
  title: string
  description?: string
  profile: PipelineProfile
  provider: { pluginKey: string; fingerprint: string }
}

export function pipelineProfileHostReady(): boolean {
  try {
    requirePluginService()
    return true
  } catch {
    return false
  }
}

export async function availablePipelines(): Promise<AvailablePipeline[]> {
  let service: ReturnType<typeof requirePluginService>
  try {
    service = requirePluginService()
  } catch {
    return []
  }
  await service.whenReady()
  const profiles: AvailablePipeline[] = []
  for (const entry of service.getDiscovered()) {
    if (!entry.pluginKey) {
      continue
    }
    const plugin = service.findApprovedPlugin(entry.pluginKey)
    if (!plugin) {
      continue
    }
    for (const profile of plugin.manifest.contributes.pipelineProfiles) {
      profiles.push({
        id: `${plugin.pluginKey}/${profile.id}`,
        version: profile.version,
        digest: pipelineDigest(profile),
        title: profile.title,
        description: profile.description,
        profile,
        provider: { pluginKey: plugin.pluginKey, fingerprint: plugin.consentFingerprint }
      })
    }
  }
  return profiles.slice(0, 128)
}

export async function resolvePipeline(selection: PipelineSelection): Promise<AvailablePipeline> {
  const profile = (await availablePipelines()).find(
    (row) =>
      row.id === selection.id &&
      row.version === selection.version &&
      row.digest === selection.digest
  )
  if (!profile) {
    throw new Error('pipeline_profile_unavailable_or_changed')
  }
  return profile
}
