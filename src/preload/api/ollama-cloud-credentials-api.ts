import type { OllamaCloudCredentialsStatus } from '../../shared/ollama-cloud'

export type OllamaCloudCredentialsApi = {
  getStatus: () => Promise<OllamaCloudCredentialsStatus>
  saveApiKey: (key: string) => Promise<OllamaCloudCredentialsStatus>
  clearApiKey: () => Promise<OllamaCloudCredentialsStatus>
}
