export const RUNTIME_ENVIRONMENT_HANDLER_CHANNELS = [
  'runtimeEnvironments:list',
  'runtimeEnvironments:addFromPairingCode',
  'runtimeEnvironments:verifyAndAddFromPairingCode',
  'runtimeEnvironments:resolve',
  'runtimeEnvironments:remove',
  'runtimeEnvironments:disconnect',
  'runtimeEnvironments:connect',
  'runtimeEnvironments:retryControlConnection',
  'runtimeEnvironments:prepareBrowserClientHostPlacement',
  'runtimeEnvironments:getStatus',
  'runtimeEnvironments:call',
  'runtimeEnvironments:subscribe',
  'runtimeEnvironments:unsubscribe'
] as const
