import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { SSH_CONNECTION_STATUS } from '../transport/ssh-connection-status-arms'

const sourceText = (name: string) => salvagedOptional(name, z.string())

// Require only targetId/status: dropping state for an unread field could turn auth-failed into the connect path’s connected fallback.
// Unknown status degrades to disconnected, preserving every consumer’s label/readiness verdict.
export const sshConnectionStateSchema = z
  .looseObject({
    state: salvagedOptional(
      'state',
      z
        .looseObject({
          targetId: z.string(),
          status: openEnum(SSH_CONNECTION_STATUS, 'disconnected'),
          error: salvagedOptional('error', z.string().nullable()),
          reconnectAttempt: salvagedOptional('reconnectAttempt', z.number()),
          connectionGeneration: salvagedOptional('connectionGeneration', z.number()),
          // Older hosts omit start-refusal details; use them only for desktop recovery hints.
          managedServer: salvagedOptional(
            'managedServer',
            z.looseObject({
              kind: salvagedOptional('kind', z.string()),
              serving: salvagedOptional(
                'serving',
                z.looseObject({
                  state: salvagedOptional('state', z.string()),
                  detail: salvagedOptional('detail', z.string())
                })
              )
            })
          )
        })
        .nullable()
    )
  })
  .transform((reply) => reply.state)

// Agent ids are string-matched; discard non-string elements without failing the advisory probe.
export const detectedAgentIdsSchema = salvagingArray(z.string())

// Hook fields are guarded; preserve unknown setup policy strings so callers retain their existing skip behavior.
export const repoSetupHooksSchema = z.looseObject({
  hooks: salvagedOptional(
    'hooks',
    z
      .looseObject({
        scripts: salvagedOptional('scripts', z.looseObject({ setup: sourceText('setup') }))
      })
      .nullable()
  ),
  source: salvagedOptional('source', z.string().nullable()),
  setupRunPolicy: sourceText('setupRunPolicy'),
  setupTrust: salvagedOptional(
    'setupTrust',
    z
      .looseObject({
        contentHash: sourceText('contentHash'),
        scriptContent: sourceText('scriptContent')
      })
      .nullable()
  )
})

// Preset id/name/directories are read unguarded; optional metadata must not invalidate older rows.
const sparsePreset = z.looseObject({
  id: z.string(),
  name: z.string(),
  directories: salvagingArray(z.string()),
  repoId: sourceText('repoId'),
  createdAt: salvagedOptional('createdAt', z.number()),
  updatedAt: salvagedOptional('updatedAt', z.number())
})

// The list is read unguarded; failure leaves presetsLoaded false and disables creation, while its error state is currently unread.
export const repoSparsePresetListSchema = z
  .looseObject({ presets: salvagingArray(sparsePreset) })
  .transform((reply) => reply.presets)

// Missing saved presets retain the caller’s Failed to save sparse preset path.
export const repoSparsePresetSaveSchema = z
  .looseObject({ preset: salvagedOptional('preset', sparsePreset) })
  .transform((reply) => reply.preset)

// Both search representations are supported; consumers choose refDetails or refs without requiring both.
export const repoBaseRefSearchSchema = z.looseObject({
  refs: salvagedOptional('refs', salvagingArray(z.string())),
  refDetails: salvagedOptional(
    'refDetails',
    salvagingArray(z.looseObject({ refName: z.string(), localBranchName: z.string() }))
  )
})
