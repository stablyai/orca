import type { ProviderHandler } from './types'

type VertexProviderConfig = {
  projectId?: string
  region?: string
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
    materialize: async () => {
      throw new Error('google-vertex materialize not yet implemented')
    },
    validate: async () => {
      throw new Error('google-vertex validate not yet implemented')
    }
  }
}
