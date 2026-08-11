import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--preview-port <port> --preview-domain <host>] [--preview-bind <host>] [--preview-auth open|token] [--preview-token <secret>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json',
      'preview-port',
      'preview-bind',
      'preview-domain',
      'preview-auth',
      'preview-token'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.',
      '--preview-port starts a single-port preview proxy that exposes workspace dev servers as <worktree>[--<port>].<preview-domain>, routed by Host header. Point a wildcard DNS record and reverse-proxy route for *.<preview-domain> at this one port.',
      '--preview-bind defaults to 127.0.0.1 (reverse proxy on the same machine). --preview-auth defaults to open on loopback binds and token otherwise; token mode generates a secret when --preview-token is not given and prints it in the ready block.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing',
      'orca serve --port 6768 --preview-port 6769 --preview-domain https://preview.example.com',
      'orca serve --preview-port 6769 --preview-bind 0.0.0.0 --preview-domain preview.example.com --preview-auth token'
    ]
  }
]
