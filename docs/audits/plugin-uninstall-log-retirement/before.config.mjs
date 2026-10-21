process.env.ORCA_PLUGIN_LOG_VARIANT = 'before'
const { default: config } = await import('./phase.config.mjs')
config.test.include = ['src/main/plugins/plugin-uninstall-log-retention.test.ts']
export default config
