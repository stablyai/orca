import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProviderHandler } from './types'
import type { ClaudeModelMapping } from '../../../shared/types'

const execFile = promisify(_execFile)

type VertexProviderConfig = {
  projectId?: string
  region?: string
}

// Vertex AI model ids use `@`-versioned suffixes (vs. Bedrock's `-v1:0`).
// Kept local to the handler; P3 Task 9 hoists these into `model-defaults.ts`.
const VERTEX_DEFAULTS: Required<ClaudeModelMapping> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5@20251001'
}

export function createGoogleVertexHandler(): ProviderHandler {
  return {
    authMethod: 'google-vertex',
    registerAccount: async (input) => {
      const cfg = (input.providerConfig as VertexProviderConfig | undefined) ?? {}
      const projectId = cfg.projectId?.trim()
      const region = cfg.region?.trim()
      if (!projectId) throw new Error('GCP projectId is required for Vertex.')
      if (!region) throw new Error('GCP region is required for Vertex.')

      // Vertex auth is ADC-only — we never store a token. The claude CLI reads
      // ADC via gcloud at runtime; we only set the env switches at materialize.
      return {
        accountId: input.accountId,
        email: input.label?.trim() || `Vertex (${projectId})`,
        credentials: {
          authMethod: 'google-vertex',
          projectId,
          region
        },
        organizationUuid: null,
        organizationName: null
      }
    },
    materialize: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'google-vertex') {
        throw new Error('Google Vertex handler invoked on non-vertex account.')
      }
      // ADC-only: we emit env switches but no token. Claude CLI invokes gcloud
      // ADC at launch; the user must have run `gcloud auth application-default
      // login`. Per-account modelMapping overrides shadow the registry defaults.
      const merged: Required<ClaudeModelMapping> = { ...VERTEX_DEFAULTS, ...account.modelMapping }
      return {
        envPatch: {
          CLAUDE_CODE_USE_VERTEX: '1',
          ANTHROPIC_VERTEX_PROJECT_ID: creds.projectId,
          CLOUD_ML_REGION: creds.region,
          ANTHROPIC_DEFAULT_OPUS_MODEL: merged.opus,
          ANTHROPIC_DEFAULT_SONNET_MODEL: merged.sonnet,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: merged.haiku
        }
      }
    },
    validate: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'google-vertex') {
        return { ok: false, reason: 'Google Vertex validate invoked on non-vertex account.' }
      }
      // ADC-only probe: print-access-token resolves the user's
      // application-default credentials without burning request quota on
      // aiplatform.googleapis.com. Locked error strings let the UI map probe
      // failures to actionable rescue hints.
      try {
        await execFile('gcloud', ['auth', 'application-default', 'print-access-token'])
        return { ok: true }
      } catch (err) {
        const stderr =
          (err as { stderr?: string }).stderr ??
          (err instanceof Error ? err.message : String(err))
        if (/application-default login|Reauthentication required|credentials were not found/i.test(stderr)) {
          return {
            ok: false,
            reason: 'No GCP credentials. Run `gcloud auth application-default login`.',
            rescueHint: 'Run `gcloud auth application-default login` and retry.'
          }
        }
        if (/aiplatform\.googleapis\.com|API .* has not been used|is disabled/i.test(stderr)) {
          return {
            ok: false,
            reason: 'Project does not have Vertex AI / Claude enabled.',
            rescueHint: 'Enable the Vertex AI API and request Claude model access in the GCP console.'
          }
        }
        return {
          ok: false,
          reason: 'Network or gcloud error contacting Vertex AI.',
          rescueHint: 'Check your network and gcloud CLI installation.'
        }
      }
    }
  }
}
