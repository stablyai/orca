import type { PiRpcLaunchOptions } from './child-environment'

export function parsePiRpcWorkerOptions(argv: string[]): PiRpcLaunchOptions {
  const options: PiRpcLaunchOptions = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      (flag !== '--model' && flag !== '--effort') ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > 512
    ) {
      throw new Error('Invalid pi-rpc-worker launch options')
    }
    const key = flag === '--model' ? 'model' : 'effort'
    if (options[key] !== undefined) {
      throw new Error('Duplicate pi-rpc-worker launch option')
    }
    options[key] = value
  }
  if (options.effort && !options.model) {
    throw new Error('pi-rpc-worker --effort requires --model')
  }
  return options
}
