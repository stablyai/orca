// A system interruption may outlive JavaScript's cancellation or a newer explicit start.
struct RecordingInterruptionIntent {
    enum EndAction: Equatable { case resume, blocked, none }
    private var pendingResume = false

    mutating func began(wasRecording: Bool) {
        pendingResume = wasRecording
    }

    mutating func cancel() {
        pendingResume = false
    }

    mutating func ended(shouldResume: Bool, isRecording: Bool) -> EndAction {
        let resume = pendingResume && shouldResume
        pendingResume = false
        if resume { return .resume }
        return isRecording ? .none : .blocked
    }
}
