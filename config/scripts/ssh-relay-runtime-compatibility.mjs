export const sshRelayRuntimeCompatibility = Object.freeze({
  'linux-x64-glibc': {
    kind: 'linux',
    minimumKernelVersion: '4.18',
    libc: {
      family: 'glibc',
      minimumVersion: '2.28',
      minimumLibstdcxxVersion: '6.0.25',
      minimumGlibcxxVersion: '3.4.25'
    }
  },
  'linux-arm64-glibc': {
    kind: 'linux',
    minimumKernelVersion: '4.18',
    libc: {
      family: 'glibc',
      minimumVersion: '2.28',
      minimumLibstdcxxVersion: '6.0.25',
      minimumGlibcxxVersion: '3.4.25'
    }
  },
  'darwin-x64': { kind: 'darwin', minimumVersion: '13.5' },
  'darwin-arm64': { kind: 'darwin', minimumVersion: '13.5' },
  'win32-x64': {
    // Why: tuple OS uses `win32`, but the signed manifest's compatibility union uses `windows`.
    kind: 'windows',
    minimumBuild: 19045,
    minimumOpenSshVersion: '8.1p1',
    minimumPowerShellVersion: '5.1',
    minimumDotNetFrameworkRelease: 528040
  },
  'win32-arm64': {
    kind: 'windows',
    minimumBuild: 26100,
    minimumOpenSshVersion: '8.1p1',
    minimumPowerShellVersion: '5.1',
    minimumDotNetFrameworkRelease: 528040
  }
})
