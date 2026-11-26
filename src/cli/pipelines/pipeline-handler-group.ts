import type { HandlerGroup } from '../dispatch/handler-group-manifest'
import { PIPELINE_V2_ONLY_COMMANDS } from '../pipeline-v2-command-paths'

export const PIPELINE_HANDLER_GROUP: HandlerGroup = {
  name: 'pipeline',
  keys: [
    ...PIPELINE_V2_ONLY_COMMANDS.map((command) => `pipeline ${command}`),
    'pipeline list',
    'pipeline profiles',
    'pipeline describe',
    'pipeline status',
    'pipeline context',
    'pipeline reconcile',
    'pipeline pause',
    'pipeline resume',
    'pipeline revalidate',
    'pipeline receipt',
    'pipeline submit',
    'pipeline configure'
  ],
  load: async () => (await import('./pipeline.js')).PIPELINE_HANDLERS
}
