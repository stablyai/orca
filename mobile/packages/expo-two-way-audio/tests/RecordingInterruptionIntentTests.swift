@main
struct RecordingInterruptionIntentTests {
    static func main() {
        var intent = RecordingInterruptionIntent()
        // An idle audio interruption never starts a recording.
        intent.began(wasRecording: false)
        precondition(intent.ended(shouldResume: true, isRecording: false) == .blocked)
        // A still-owned recording resumes once, not again on a duplicate end event.
        intent.began(wasRecording: true)
        precondition(intent.ended(shouldResume: true, isRecording: false) == .resume)
        precondition(intent.ended(shouldResume: true, isRecording: false) == .blocked)
        // A blocked or missing shouldResume bit consumes the old resume request.
        intent.began(wasRecording: true)
        precondition(intent.ended(shouldResume: false, isRecording: false) == .blocked)
        precondition(intent.ended(shouldResume: true, isRecording: false) == .blocked)
        // JavaScript cancels capture after began; ended must not turn its microphone back on.
        intent.began(wasRecording: true)
        intent.cancel()
        precondition(intent.ended(shouldResume: true, isRecording: false) == .blocked)
        // A newer explicit recording must not be cancelled by the old end notification.
        intent.began(wasRecording: true)
        intent.cancel()
        precondition(intent.ended(shouldResume: true, isRecording: true) == .none)
        // The most recent interruption, even one while idle, replaces old resume intent.
        intent.began(wasRecording: true)
        intent.began(wasRecording: false)
        precondition(intent.ended(shouldResume: true, isRecording: false) == .blocked)
        print("RecordingInterruptionIntent: 8 assertions passed")
    }
}
