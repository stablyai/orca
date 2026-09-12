# macOS passkey signing

Touch ID passkeys are disabled in every Orca build channel, including release,
hourly, daily, and adhoc. Packaging must not add `keychain-access-groups`, the
passkey identity entitlements, or an embedded provisioning profile. Local and
unsigned builds keep the existing base entitlements and launcher behavior.

## Why the shipping path was removed

Electron's macOS Touch ID authenticator requires a signed keychain group such as
`<TEAM_ID>.com.stablyai.orca.webauthn` and `app.configureWebAuthn` after `ready`.
`keychain-access-groups` is restricted: macOS can kill the app before its main
process starts when the embedded provisioning profile does not authorize it.
Runtime error handling cannot protect an app that never reaches its own code.
A local reproduction of the entitlement without an authorizing profile exited
137 (`SIGKILL`).

Even a correctly signed build that launches in CI can stop launching later.
Apple's [Developer ID certificate documentation](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
under **Manage Developer ID certificate and provisioning profile expiration**,
states that the profile is evaluated at installation and every app launch:

> However, if your Developer ID provisioning profile expires, the app will no
> longer launch.

Apple also states that Developer ID profiles created after February 22, 2017 are
valid for 18 years. That long lifetime does not remove the failure: an installed
app can outlive its profile, and an app that cannot launch cannot receive an
updater repair. Certificate expiration is different; Apple says a Developer ID
app can continue running after its signing certificate expires if the certificate
was valid when the app was compiled. This finding is based on Apple's published
policy, checked September 7, 2026; no system-clock expiry experiment was needed.

Therefore a valid profile, a future expiration date, notarization, and a successful
CI launch are insufficient to meet the requirement that this feature never make
an installed Orca fail to launch. Provisioning and the restricted entitlement are
removed from every shipping channel. Setting the previous profile secrets must
not re-enable them.

## Build safeguards

The packaging policy keeps the base macOS entitlements and rejects attempts to
supply the former passkey provisioning configuration. The signed-app entitlement
verifier also rejects `keychain-access-groups` or an embedded profile,
including in nested app bundles. This check runs in the job that signs the app.
It enforces absence instead of accepting profiles that happen to be valid today.

Every macOS build workflow gates artifact upload on launching the freshly signed
app in the background and observing it survive startup. Launch checks set
`ORCA_BACKGROUND_LAUNCH=1`, use isolated app data, and never show or focus a window.
A launch failure fails the job. The launch gate catches immediate signing and
startup failures; removing the profile dependency prevents this feature's later
profile-expiry failure.

## Local failure reproduction

On September 7, 2026, the launch gate was exercised on two copies of the same
packaged Orca app on Apple silicon. The bundle's compiled main process was first
checked for the background activation policy and isolated E2E data paths.

- A copy signed with the restricted entitlement and no embedded profile failed
  the gate with `code=null, signal=SIGKILL` before the ten-second survival window.
- The same app carrying the authorizing Development profile survived that window
  and passed the launch gate. The gate then terminated its own process group.
- The static gate rejected both: the missing-profile copy for its restricted
  entitlement, and the working copy for its embedded profile.

Both launches used `ORCA_BACKGROUND_LAUNCH=1` and disposable app data; no window
was revealed. This proves the launch gate distinguishes an immediate entitlement
kill from a locally working profile. The working profile was a Development
profile, not a production Developer ID profile. It does not establish future
profile validity or replace the freshly signed CI artifact checks. Expiration
behavior above is established by Apple documentation, not this experiment.

## Requirements before reconsidering Touch ID

Do not re-enable provisioning by adding a secret or restricting it to a channel.
First establish, with Apple documentation and an appropriate experiment, a design
whose credentials can expire without preventing an installed Orca from launching.
Moving an entitlement behind a runtime condition cannot solve a pre-launch kill.

Any future design that signs an executable with a provisioning profile must also:

- Decode it with `security cms -D -i` before signing and fail on invalid input.
- Match the team, application identifier and identifier prefix, and authorized
  keychain access group against the intended signature.
- Match the actual signing certificate against `DeveloperCertificates` and require
  a Developer ID profile (`ProvisionsAllDevices`), with an explicit minimum
  remaining lifetime for `ExpirationDate`.
- Cross-check the finished executable's signature and embedded profile in the
  signing job, then launch that exact signed executable before uploading it.
- Cover mismatched, missing, malformed, expired, and soon-expiring profiles in
  automated tests, and prove immediate launch failures with a real signed app.

These checks are necessary for a future provisioned executable, but are not a
solution to the installed-app expiration problem. The current policy rejects all
profiles, so certificate/profile matching cannot create an exception to it.

## Browser behavior

Shipped macOS builds continue to support USB security keys. They do not provide a
Touch ID platform authenticator or offer existing iCloud Keychain passkeys. Sites
may still report partial passkey support or wait for a security key; use another
sign-in method when needed. The original platform-passkey sign-in issue remains
unresolved by this safety change. Windows and Linux behavior is unchanged.
