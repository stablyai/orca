import { defineConfig } from 'i18next-cli'

const output =
  process.env.ORCA_I18N_EXTRACTION_OUTPUT ?? 'tmp/localization-extraction/{{language}}.json'

export default defineConfig({
  locales: ['en'],
  extract: {
    input: ['src/**/*.{js,jsx,ts,tsx,mts,cts}'],
    ignore: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/__snapshots__/**',
      '**/assets/**'
    ],
    output,
    defaultNS: false,
    functions: ['t', '*.t', 'translate', 'translateMain'],
    useTranslationNames: ['useTranslation'],
    sort: true,
    disablePlurals: true,
    removeUnusedKeys: true
  }
})
