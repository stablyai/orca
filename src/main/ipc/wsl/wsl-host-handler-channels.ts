export const WSL_HOST_HANDLER_CHANNELS = [
  'wslHosts:listDistros',
  'wslHosts:add',
  'wslHosts:remove',
  'wslHosts:connect',
  'wslHosts:getStatuses',
  'wslHosts:setVisibleWork',
  'wslHosts:focusHost',
  'wslHosts:getCapability'
] as const
