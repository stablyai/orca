import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_WSL_E2E_SOURCE_ROUTES = [
  {
    id: 'wsl-host.fake-connector',
    specs: ['tests/e2e/wsl-host-fake-transport.spec.ts', 'tests/e2e/wsl-host-chat.spec.ts'],
    matches: (file) => file === 'src/main/wsl/wsl-host-e2e-fake-connector.ts'
  },
  {
    // Remove runs through the fake transport spec; its peer check asks the server who else uses it.
    id: 'wsl-host.remove',
    specs: ['tests/e2e/wsl-host-fake-transport.spec.ts'],
    matches: (file) =>
      /^src\/main\/wsl\/(?:wsl-host-server-stop|wsl-host-peer-desktops|wsl-host-removal)\.ts$/.test(
        file
      )
  },
  {
    id: 'terminal.windows-wsl-launch-and-paste',
    specs: [
      'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
      'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      /^(?:config\/scripts\/(?:verify-wsl-e2e-participation|verify-wsl-no-background-boot-participation|verify-playwright-participation)\.mjs$|src\/main\/(?:wsl[/-]|pty\/.*wsl|providers\/wsl)|src\/shared\/(?:wsl-|windows-terminal-shell|shell-argument-quoting)|src\/renderer\/src\/.*(?:terminal-paste|pty-paste)|tests\/e2e\/(?:golden-tab-bar-agent-launch\.spec|terminal-windows-shell-paste-ownership\.spec|terminal-inline-images-windows\.spec|wsl-bridge-no-background-boot\.spec|helpers\/(?:wsl-golden-stub-agent|golden-stub-agent))|\.github\/(?:actions\/setup-wsl-test-runtime\/|workflows\/windows-wsl-e2e\.yml))/.test(
        file
      )
  }
]
