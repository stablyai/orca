package ipc

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestEncodeLineAppendsNewline(t *testing.T) {
	line, err := EncodeLine(Response{ID: "1", OK: true})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(line, []byte("\n")) {
		t.Fatalf("encoded line missing newline: %q", line)
	}
	var back Response
	if err := json.Unmarshal(bytes.TrimSpace(line), &back); err != nil {
		t.Fatalf("round-trip unmarshal: %v", err)
	}
	if back.ID != "1" || !back.OK {
		t.Fatalf("round-trip mismatch: %+v", back)
	}
}

func collectRequests(t *testing.T, input string) ([]Request, int) {
	t.Helper()
	var reqs []Request
	errCount := 0
	if err := ReadRequests(strings.NewReader(input), func(r Request) {
		reqs = append(reqs, r)
	}, func(error) { errCount++ }); err != nil {
		t.Fatalf("ReadRequests returned error: %v", err)
	}
	return reqs, errCount
}

func TestReadRequestsParsesMultipleLines(t *testing.T) {
	reqs, errs := collectRequests(t,
		`{"id":"1","type":"hello","token":"t"}`+"\n"+
			`{"id":"2","type":"status","token":"t"}`+"\n")
	if errs != 0 {
		t.Fatalf("unexpected parse errors: %d", errs)
	}
	if len(reqs) != 2 {
		t.Fatalf("got %d requests, want 2", len(reqs))
	}
	if reqs[0].Type != "hello" || reqs[1].Type != "status" {
		t.Fatalf("unexpected requests: %+v", reqs)
	}
}

func TestReadRequestsSkipsBlankLines(t *testing.T) {
	reqs, errs := collectRequests(t, "\n"+`{"id":"1","type":"status"}`+"\n\n")
	if errs != 0 || len(reqs) != 1 {
		t.Fatalf("blank lines mishandled: reqs=%d errs=%d", len(reqs), errs)
	}
}

func TestReadRequestsReportsMalformedLineWithoutAborting(t *testing.T) {
	// A bad line in the middle must be reported but not drop the good lines.
	reqs, errs := collectRequests(t,
		`{"id":"1","type":"status"}`+"\n"+
			`{not json}`+"\n"+
			`{"id":"2","type":"status"}`+"\n")
	if errs != 1 {
		t.Fatalf("expected 1 parse error, got %d", errs)
	}
	if len(reqs) != 2 {
		t.Fatalf("expected 2 good requests around the bad line, got %d", len(reqs))
	}
}
