import nextConfig from 'eslint-config-next'

const config = [
  ...nextConfig,
  {
    ignores: ['.source/**', 'node_modules/**', 'tsconfig.tsbuildinfo']
  }
]

export default config
