export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'linux'
