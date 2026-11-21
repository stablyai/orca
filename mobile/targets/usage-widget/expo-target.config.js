/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'OrcaUsageWidget',
  displayName: 'Orca Usage',
  bundleIdentifier: '.usagewidget',
  // containerBackground and the widget URL APIs it uses need iOS 17.
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups']
  }
})
