import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve', 'update-helper', 'install'],
    summary: 'Print the root setup script for the serve auto-update helper',
    usage:
      'orca serve update-helper install [--spool-dir <dir>] [--unit <name>] [--appimage <path>] [--version-record <path>] [--service-user <user>] [--out <file>]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spool-dir',
      'unit',
      'appimage',
      'version-record',
      'service-user',
      'out'
    ],
    notes: [
      'Prints a bash script to stdout that installs the root-owned update helper and its sudoers rule.',
      'Run it with `sudo bash <script>` (or pipe it: `orca serve update-helper install | sudo bash`).',
      'The helper lets the orca service user apply AppImage updates without a password prompt.',
      'Re-running the script upgrades the helper in place; it is safe to run repeatedly.'
    ],
    examples: [
      'orca serve update-helper install | sudo bash',
      'orca serve update-helper install --unit orca-serve.service --service-user orca | sudo bash'
    ]
  },
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  }
]
