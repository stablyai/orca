export function createHostedIosNativeBaselineStep({
  assertNoHostedMobileWebCdpTarget,
  discoveryUrl,
  evidenceStep
}) {
  return async (label, run) => {
    await evidenceStep(`${label} hosted target exclusion`, () =>
      assertNoHostedMobileWebCdpTarget({ discoveryUrl })
    )
    const result = await evidenceStep(label, run)
    await evidenceStep(`${label} hosted target exclusion after capture`, () =>
      assertNoHostedMobileWebCdpTarget({ discoveryUrl })
    )
    return result
  }
}
