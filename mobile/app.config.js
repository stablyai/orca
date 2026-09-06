const app = require('./app.json')

module.exports = () => {
  const config = app.expo
  const routerRoot = process.env.ORCA_EXPO_ROUTER_ROOT
  if (!routerRoot) {
    return config
  }
  const webConfig = { ...config }
  delete webConfig.android
  delete webConfig.icon
  delete webConfig.ios
  delete webConfig.splash
  return {
    ...webConfig,
    platforms: ['web'],
    extra: {
      ...config.extra,
      router: { root: routerRoot }
    }
  }
}
