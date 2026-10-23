// Why one entry: electron-vite replaces out/main, so the CLI can only load modules built as entries.
export { localBundledSkillInput } from './local-host'
export { installBundledSkills, previewBundledSkillInstall } from './service'
