import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  LinuxPackageInstallInstructions,
  LinuxPackageInstallRecovery
} from '../../../shared/update-status-types'
import { UpdateErrorCardContent } from './UpdateErrorCardContent'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'

function copiedNote(packageFileName: string): string {
  return translate(
    'auto.components.LinuxPackageInstallRecoveryCard.aa57fa4f80',
    'Command copied. Quit Orca, run it in a system terminal to install {{value0}}, then reopen Orca.',
    {
      value0: packageFileName
    }
  )
}

function toMessage(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
  // Electron prefixes rejected invoke() results with the channel; keep only the user-safe tail.
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

export function LinuxPackageInstallRecoveryCard({
  recovery,
  diagnostic,
  releaseUrl,
  onClose
}: {
  recovery: LinuxPackageInstallRecovery
  diagnostic: string
  releaseUrl?: string
  onClose: () => void
}) {
  // Why: i18n boots in English and swaps catalogs after the persisted language loads, so these must
  // be resolved per render — at module scope they would freeze the whole card in English.
  const TITLE = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.53e1559f99',
    'Manual Install Required'
  )
  const SUMMARY = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.a7ac6ec78b',
    'Orca downloaded the system package. Quit Orca before finishing the update from a terminal.'
  )
  const EXPLAINER = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.82c6dbea00',
    'Copy the command, quit Orca, and run it in a system terminal on the computer where Orca is installed. Reopen Orca after it finishes.'
  )
  const AGENT_NOTE = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.53c4b8e148',
    'No usable authentication agent answered the privileged install request.'
  )
  const TRUST_NOTE = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.b7e7c5bc95',
    'Orca checks the downloaded file against the release metadata at the moment it builds this command. The system package itself is not signature-checked, and Orca cannot vouch for the file after that point.'
  )
  const CHECKING_LABEL = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.c732bcbf8f',
    'Checking package...'
  )
  const [pendingAction, setPendingAction] = useState<'copy' | 'show' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Why: the trusted system directories lack sudo or a package manager — no command can be offered at all.
  const [commandUnavailable, setCommandUnavailable] = useState(false)
  const mountedRef = useMountedRef()
  const recoveryRef = useRef(recovery)
  useLayoutEffect(() => {
    recoveryRef.current = recovery
  }, [recovery])
  const isCurrentRecovery = (): boolean => mountedRef.current && recoveryRef.current === recovery

  const handleCopyCommand = (): void => {
    if (pendingAction) {
      return
    }
    setPendingAction('copy')
    setActionError(null)
    void (async () => {
      let instructions: LinuxPackageInstallInstructions
      try {
        instructions = await window.api.updater.getLinuxPackageInstallInstructions()
      } catch (error) {
        // Why: only main knows whether the machine simply has no package manager; any other failure
        // (stale status, untrusted sender, invalid artifact) must not demote the copy path.
        if (isCurrentRecovery()) {
          setActionError(toMessage(error))
        }
        return
      }
      if (!instructions.ok) {
        if (isCurrentRecovery()) {
          setCommandUnavailable(true)
          setActionError(instructions.message)
        }
        return
      }
      if (!isCurrentRecovery()) {
        return
      }
      try {
        await window.api.ui.writeClipboardText(instructions.command)
        if (isCurrentRecovery()) {
          toast.success(copiedNote(instructions.packageFileName))
        }
      } catch (error) {
        // Why: the command itself is valid — only the clipboard failed, so keep the copy action.
        if (isCurrentRecovery()) {
          setActionError(toMessage(error))
        }
      }
    })().finally(() => {
      if (mountedRef.current) {
        setPendingAction(null)
      }
    })
  }

  const handleShowPackage = (): void => {
    if (pendingAction) {
      return
    }
    setPendingAction('show')
    setActionError(null)
    void window.api.updater
      .showLinuxPackage()
      .catch((error: unknown) => {
        if (isCurrentRecovery()) {
          setActionError(toMessage(error))
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setPendingAction(null)
        }
      })
  }

  // Why: the label keeps naming its action while the toast carries transient confirmation.
  const copyAction = {
    label: translate(
      'auto.components.LinuxPackageInstallRecoveryCard.55c86654b7',
      'Copy Install Command'
    ),
    pendingLabel: CHECKING_LABEL,
    isPending: pendingAction === 'copy',
    disabled: pendingAction !== null,
    onClick: handleCopyCommand
  }
  const showAction = {
    label: translate('auto.components.LinuxPackageInstallRecoveryCard.e3de29c86a', 'Show Package'),
    pendingLabel: CHECKING_LABEL,
    isPending: pendingAction === 'show',
    disabled: pendingAction !== null,
    onClick: handleShowPackage
  }
  const officialReleaseAction = releaseUrl
    ? {
        label: translate('auto.components.UpdateCard.47126bcf57', 'Download Manually'),
        onClick: () => {
          setActionError(null)
          void window.api.shell.openUrl(releaseUrl).catch((error: unknown) => {
            if (isCurrentRecovery()) {
              setActionError(toMessage(error))
            }
          })
        }
      }
    : undefined

  const detail = [
    recovery.reason === 'authentication-agent-unavailable' ? AGENT_NOTE : null,
    recovery.reason === 'manual-install-required' ? null : diagnostic,
    TRUST_NOTE
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <UpdateErrorCardContent
      title={TITLE}
      summary={SUMMARY}
      explainer={commandUnavailable ? undefined : EXPLAINER}
      detail={detail}
      // Why: with no safe command to copy, revealing the retained package becomes the primary path.
      primaryAction={commandUnavailable ? showAction : copyAction}
      secondaryAction={commandUnavailable ? undefined : showAction}
      tertiaryAction={officialReleaseAction}
      footnote={actionError ? { text: actionError, tone: 'destructive' } : undefined}
      onClose={onClose}
    />
  )
}
