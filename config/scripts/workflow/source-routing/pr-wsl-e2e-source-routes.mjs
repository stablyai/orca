import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_WSL_E2E_SOURCE_ROUTES = [
  {
    id: 'wsl-host.fake-connector',
    specs: ['tests/e2e/remote/wsl-hosts/wsl-host-fake-transport.spec.ts'],
    matches: (file) => file === 'src/main/wsl/host-lifecycle/wsl-host-e2e-fake-connector.ts'
  },
  {
    // Remove runs through the fake transport spec; its peer check asks the server who else uses it.
    id: 'wsl-host.remove',
    specs: ['tests/e2e/remote/wsl-hosts/wsl-host-fake-transport.spec.ts'],
    matches: (file) =>
      /^src\/main\/wsl\/host-lifecycle\/(?:wsl-host-server-stop|wsl-host-peer-desktops|wsl-host-removal)\.ts$/.test(
        file
      )
  },
  {
    id: 'terminal.windows-wsl-launch-and-paste',
    specs: [
      'tests/e2e/golden-journeys/golden-tab-bar-agent-launch.spec.ts',
      'tests/e2e/terminal/input/terminal-windows-shell-paste-ownership.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /(?:^(?:config\/scripts\/(?:runtime-verification\/participation\/)?(?:verify-wsl-e2e-participation|verify-wsl-no-background-boot-participation|verify-playwright-participation)\.mjs$|config\/scripts\/(?:runtime-verification\/participation\/)?runtime-verification\/participation\/verify-playwright-participation\.mjs$|src\/main\/(?:wsl[/-]|pty\/.*wsl|providers\/wsl)|src\/shared\/(?:wsl-|shell\/launch\/(?:windows-terminal-shell|shell-argument-quoting))|src\/renderer\/src\/.*(?:terminal-paste|pty-paste)|\.github\/(?:actions\/setup-wsl-test-runtime\/|workflows\/windows-wsl-e2e\.yml))|^(?:tests\/e2e\/golden-journeys\/golden-stub-agent\.ts|tests\/e2e\/golden-journeys\/golden-tab-bar-agent-launch\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-bridge-no-background-boot\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-golden-stub-agent\.ts|tests\/e2e\/terminal\/input\/terminal-windows-shell-paste-ownership\.spec\.ts)$)/.test(
        file
      )
  }
]
