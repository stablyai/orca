import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LinuxPackageInstallInstructions,
  LinuxPackageInstallRecovery
} from '../../../shared/types'
import { UpdateErrorCardContent } from './UpdateErrorCardContent'
import { translate } from '@/i18n/i18n'

const COPY_CONFIRMATION_MS = 4_000

function copiedNote(packageFileName: string): string {
  return translate(
    'auto.components.LinuxPackageInstallRecoveryCard.aa57fa4f80',
    'Command copied. Run it in a system terminal to install {{value0}}, then quit and reopen Orca.',
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
    'Automatic Install Failed'
  )
  const SUMMARY = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.a7ac6ec78b',
    'Orca downloaded the update but could not install the system package automatically.'
  )
  const EXPLAINER = translate(
    'auto.components.LinuxPackageInstallRecoveryCard.82c6dbea00',
    'Copy the command and run it in a system terminal on the computer where Orca is installed. After it finishes, quit and reopen Orca to run the new version.'
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
  const [pendingAction, setPendingAction] = useState<'copy' | 'show' | 'retry' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copiedFileName, setCopiedFileName] = useState<string | null>(null)
  // Why: the trusted system directories lack sudo or a package manager — no command can be offered at all.
  const [commandUnavailable, setCommandUnavailable] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Why: quitAndInstall resolves as soon as main schedules the install, so a failed retry never
  // rejects — it arrives as a new recovery status. Without this the busy slot never clears and every
  // action stays inert for the rest of the session.
  useEffect(() => {
    setPendingAction((current) => (current === 'retry' ? null : current))
  }, [recovery])

  useEffect(() => {
    if (!copiedFileName) {
      return
    }
    const timer = window.setTimeout(() => setCopiedFileName(null), COPY_CONFIRMATION_MS)
    return () => window.clearTimeout(timer)
  }, [copiedFileName])

  const handleCopyCommand = useCallback(() => {
    if (pendingAction) {
      return
    }
    setPendingAction('copy')
    setActionError(null)
    setCopiedFileName(null)
    void (async () => {
      let instructions: LinuxPackageInstallInstructions
      try {
        instructions = await window.api.updater.getLinuxPackageInstallInstructions()
      } catch (error) {
        // Why: only main knows whether the machine simply has no package manager; any other failure
        // (stale status, untrusted sender, invalid artifact) must not demote the copy path.
        if (mountedRef.current) {
          setActionError(toMessage(error))
        }
        return
      }
      if (!instructions.ok) {
        if (mountedRef.current) {
          setCommandUnavailable(true)
          setActionError(instructions.message)
        }
        return
      }
      try {
        await window.api.ui.writeClipboardText(instructions.command)
        if (mountedRef.current) {
          setCopiedFileName(instructions.packageFileName)
        }
      } catch (error) {
        // Why: the command itself is valid — only the clipboard failed, so keep the copy action.
        if (mountedRef.current) {
          setActionError(toMessage(error))
        }
      }
    })().finally(() => {
      if (mountedRef.current) {
        setPendingAction(null)
      }
    })
  }, [pendingAction])

  const handleShowPackage = useCallback(() => {
    if (pendingAction) {
      return
    }
    setPendingAction('show')
    setActionError(null)
    setCopiedFileName(null)
    void window.api.updater
      .showLinuxPackage()
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setActionError(toMessage(error))
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setPendingAction(null)
        }
      })
  }, [pendingAction])

  const handleRetryAutomatic = useCallback(() => {
    // Why: guard in the handler, not only through the disabled prop, so no path can quit and install mid-hash.
    if (pendingAction) {
      return
    }
    // Why: the quit sequence owns the app from here; hold the busy slot so no other action starts
    // work mid-quit. Released by the effect above when a fresh recovery status says Orca stayed open.
    setPendingAction('retry')
    setActionError(null)
    setCopiedFileName(null)
    // Why: a fresh install attempt re-evaluates the machine, so an earlier "no command" verdict must not stick.
    setCommandUnavailable(false)
    void window.api.updater.quitAndInstall().catch((error: unknown) => {
      if (mountedRef.current) {
        setActionError(toMessage(error))
        setPendingAction(null)
      }
    })
  }, [pendingAction])

  // Why: the label keeps naming its action — the footnote below the buttons carries the confirmation.
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
  const retryAction = {
    label: translate(
      'auto.components.LinuxPackageInstallRecoveryCard.3da99454c6',
      'Try Automatic Install Again'
    ),
    disabled: pendingAction !== null,
    onClick: handleRetryAutomatic
  }

  const officialReleaseAction = releaseUrl
    ? {
        label: translate('auto.components.UpdateCard.47126bcf57', 'Download Manually'),
        onClick: () => void window.api.shell.openUrl(releaseUrl)
      }
    : undefined

  const detail = [
    recovery.reason === 'authentication-agent-unavailable' ? AGENT_NOTE : null,
    diagnostic,
    TRUST_NOTE
  ]
    .filter(Boolean)
    .join(' ')

  const footnote = actionError
    ? { text: actionError, tone: 'destructive' as const }
    : copiedFileName
      ? { text: copiedNote(copiedFileName) }
      : undefined

  return (
    <UpdateErrorCardContent
      title={TITLE}
      summary={SUMMARY}
      explainer={commandUnavailable ? undefined : EXPLAINER}
      detail={detail}
      // Why: with no safe command to copy, revealing the retained package becomes the primary path.
      primaryAction={commandUnavailable ? showAction : copyAction}
      secondaryAction={retryAction}
      // Why: the button row only fits two actions at this card width, so the demoted mode keeps
      // Show Package and Retry there and drops the official-release link to the link row.
      tertiaryAction={commandUnavailable ? officialReleaseAction : showAction}
      footnote={footnote}
      onClose={onClose}
    />
  )
}
