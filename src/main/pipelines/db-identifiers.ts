import { randomBytes } from 'crypto'

export function generatePipelineId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
