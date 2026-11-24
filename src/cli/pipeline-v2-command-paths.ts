export const PIPELINE_V2_ONLY_COMMANDS = [
  'retry',
  'events',
  'requests',
  'discuss',
  'template list',
  'template show',
  'template save',
  'template delete',
  'template validate',
  'template publish-request',
  'template disable-request',
  'template receipt',
  'decision request',
  'decision receipt',
  'budget request',
  'budget receipt'
] as const
export const pipelineV2Method = (command: string) =>
  `pipeline.v2.${command.replaceAll(' ', '.').replace('publish-request', 'publishRequest').replace('disable-request', 'disableRequest')}`
