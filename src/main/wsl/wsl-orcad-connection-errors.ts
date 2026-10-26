import type { WslOrcadLaunch } from './wsl-orcad-deploy'

type WslOrcadDeferredLaunch = Extract<WslOrcadLaunch, { outcome: 'deferred' }>

/** orcad installed an update it may not activate yet (live terminals); nothing is listening. */
export class WslOrcadLaunchDeferredError extends Error {
  constructor(readonly launch: WslOrcadDeferredLaunch) {
    super(launch.reason)
    this.name = 'WslOrcadLaunchDeferredError'
  }
}

export class WslOrcadConnectionSupersededError extends Error {
  constructor(distro: string) {
    super(`The connection to the WSL distro ${distro} was closed while it was being opened.`)
    this.name = 'WslOrcadConnectionSupersededError'
  }
}
