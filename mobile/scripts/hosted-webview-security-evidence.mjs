import {
  verifyHostedWebViewNavigationIsolation,
  verifyHostedWebViewNetworkIsolation
} from './hosted-webview-cdp-session.mjs'
import { verifyHostedWebViewExecutableIsolation } from './hosted-webview-executable-isolation.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'

export async function captureHostedWebViewSecurityEvidence({
  document,
  evidenceStep,
  probeId,
  workspacePrivacyIsolation
}) {
  const networkIsolation = await evidenceStep('network isolation probe', () =>
    verifyHostedWebViewNetworkIsolation({ document, probeId })
  )
  const navigationIsolation = await evidenceStep('navigation isolation probe', () =>
    verifyHostedWebViewNavigationIsolation({ document, probeId })
  )
  const executableIsolation = await evidenceStep('executable isolation probe', () =>
    verifyHostedWebViewExecutableIsolation({ document, probeId })
  )
  const privacyIsolation =
    workspacePrivacyIsolation ??
    (await evidenceStep('privacy isolation probe', () =>
      verifyHostedWebViewPrivacyIsolation({ document })
    ))
  return { executableIsolation, navigationIsolation, networkIsolation, privacyIsolation }
}
