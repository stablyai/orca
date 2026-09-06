export async function evidenceStep(label, run) {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}

export function printHostedWebViewE2eReport(evidence) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        device: evidence.deviceUdid,
        targetId: evidence.workspaceDocument.targetId,
        route: evidence.workspaceDocument.href,
        nativeAppPath: evidence.nativeAppPath,
        visibleText: evidence.expectedWorkspace,
        interactiveControls: evidence.workspaceDocument.buttonCount,
        networkIsolation: evidence.networkIsolation,
        navigationIsolation: evidence.navigationIsolation,
        executableIsolation: evidence.executableIsolation,
        privacyIsolation: evidence.privacyIsolation,
        nativeOnboarding: evidence.nativeOnboarding,
        nativeAlert: evidence.nativeAlert.evidence,
        documentUpload: evidence.terminalDeviceInput?.documentUpload?.evidence ?? null,
        photoPermissionDenial:
          evidence.terminalDeviceInput?.photoPermissionDenial?.evidence ?? null,
        photoPermissionRevocation:
          evidence.terminalDeviceInput?.photoPermissionRevocation?.evidence ?? null,
        terminalClipboardImagePaste:
          evidence.terminalDeviceInput?.terminalClipboardImagePaste?.evidence ?? null,
        terminalClipboardPaste:
          evidence.terminalDeviceInput?.terminalClipboardPaste.evidence ?? null,
        workspaceParity: evidence.hostedWorkspace,
        accountsParity: evidence.hostedAccounts?.evidence ?? null,
        agentHistory: evidence.historyEvidence,
        coreRouteParity: evidence.hostedCoreRoutes?.evidence ?? null,
        filesPreviewParity: evidence.hostedFilesPreview?.evidence ?? null,
        sourceControlReview: evidence.sourceControlReview,
        adversarialContent: evidence.adversarialContent,
        adversarialProviderContent: evidence.adversarialProviderContent,
        adversarialTerminalLinks: evidence.adversarialTerminalLinks
      },
      null,
      2
    )
  )
}
