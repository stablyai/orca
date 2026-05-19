import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: --key-env / --token-env name the env var that holds the secret rather
// than the secret itself, so secrets never reach argv or the shell history.
const ADD_FLAGS = [
  'provider',
  'label',
  'key-env',
  'token-env',
  'preset',
  'base-url',
  'resource',
  'use-entra-id',
  'region',
  'project-id',
  'validate'
]

export const CLAUDE_ACCOUNTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['claude-accounts', 'add'],
    summary: 'Add a Claude managed account (headless; reads secrets from env vars)',
    usage:
      'orca claude-accounts add --provider <provider> [--label <text>] [provider-specific flags] [--validate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...ADD_FLAGS],
    notes: [
      'Secrets are read from environment variables named by --key-env / --token-env to avoid leaking via argv or transcripts.',
      'Providers: anthropic-api-key, anthropic-compat, azure-foundry, aws-bedrock, google-vertex.',
      'Pass --validate to probe the provider before saving.'
    ],
    examples: [
      'ANTHROPIC_API_KEY_INPUT=sk-ant-… orca claude-accounts add --provider anthropic-api-key --label "Work" --key-env ANTHROPIC_API_KEY_INPUT --json',
      'GLM_TOKEN=… orca claude-accounts add --provider anthropic-compat --preset zai --label "GLM" --token-env GLM_TOKEN --json',
      'X_TOKEN=… orca claude-accounts add --provider anthropic-compat --preset custom --base-url https://x --label "Custom" --token-env X_TOKEN',
      'orca claude-accounts add --provider azure-foundry --resource myres --use-entra-id --json',
      'AWS_BEARER_TOKEN_BEDROCK=… orca claude-accounts add --provider aws-bedrock --region us-east-1 --token-env AWS_BEARER_TOKEN_BEDROCK',
      'orca claude-accounts add --provider google-vertex --project-id my-proj --region us'
    ]
  },
  {
    path: ['claude-accounts', 'list'],
    summary: 'List Claude managed accounts as JSON',
    usage: 'orca claude-accounts list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['claude-accounts', 'select'],
    summary: 'Select the active Claude managed account',
    usage: 'orca claude-accounts select <account-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account-id'],
    positionalArgs: ['account-id']
  },
  {
    path: ['claude-accounts', 'remove'],
    summary: 'Remove a Claude managed account',
    usage: 'orca claude-accounts remove <account-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account-id'],
    positionalArgs: ['account-id']
  }
]
