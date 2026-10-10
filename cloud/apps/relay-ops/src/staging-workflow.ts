import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { RELAY_GITHUB_REPOSITORY, relayWorkflowFile } from './relay-repository.js'

const execFileAsync = promisify(execFile)
const DispatchSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('status'), confirmation: z.literal('') }).strict(),
  z.object({ mode: z.literal('wake'), confirmation: z.literal('WAKE_STAGING') }).strict(),
  z.object({ mode: z.literal('sleep'), confirmation: z.literal('SLEEP_STAGING') }).strict()
])

export type StagingPowerRequest = z.infer<typeof DispatchSchema>

export function parseStagingPowerRequest(value: unknown): StagingPowerRequest {
  return DispatchSchema.parse(value)
}

export async function dispatchStagingPowerWorkflow(request: StagingPowerRequest): Promise<void> {
  const args = [
    'workflow', 'run', relayWorkflowFile('power-relay-staging.yml'),
    '--repo', RELAY_GITHUB_REPOSITORY,
    '-f', `mode=${request.mode}`,
    '-f', 'wake-cells=configured'
  ]
  if (request.confirmation) args.push('-f', `confirmation=${request.confirmation}`)
  try {
    await execFileAsync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
  } catch {
    throw new Error('Staging power workflow dispatch failed')
  }
}
